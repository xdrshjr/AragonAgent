/**
 * Input validation for every control-plane channel, hand-rolled so the app takes no new
 * run-time dependency for it.
 *
 * A validator either returns the CLEANED value or `INVALID`; it never throws and never
 * passes through a field it was not asked about. The renderer is a web page rendering
 * model-written text, so an argument is treated as hostile until it has been through here:
 * strings are length-capped, ids are matched against the same alphabet the session store
 * enforces, and objects are rebuilt field by field.
 */

import type { IpcChannel, IpcContract } from '../shared/ipc-contract.js';
import { isChromeTheme } from '../shared/window-chrome.js';

export const INVALID: unique symbol = Symbol('invalid');
export type Validator<T> = (raw: unknown) => T | typeof INVALID;

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_TEXT = 200_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (max = 4096, min = 0): Validator<string> => (raw) =>
  typeof raw === 'string' && raw.length >= min && raw.length <= max && !raw.includes('\0') ? raw : INVALID;

const optional = <T>(inner: Validator<T>): Validator<T | undefined> => (raw) =>
  raw === undefined ? undefined : inner(raw);

const nullable = <T>(inner: Validator<T>): Validator<T | null> => (raw) => (raw === null ? null : inner(raw));

const bool: Validator<boolean> = (raw) => (typeof raw === 'boolean' ? raw : INVALID);
const sessionId: Validator<string> = (raw) => (typeof raw === 'string' && SESSION_ID.test(raw) ? raw : INVALID);

const plainObject: Validator<Record<string, unknown>> = (raw) => {
  if (!isRecord(raw)) return INVALID;
  // Reject prototype-pollution keys outright instead of trying to be clever about them.
  const dangerous = (value: unknown, depth: number): boolean => {
    if (depth > 6 || typeof value !== 'object' || value === null) return depth > 6;
    return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype' || dangerous(child, depth + 1));
  };
  return dangerous(raw, 0) ? INVALID : raw;
};

type Shape<T> = { [K in keyof T]-?: Validator<T[K]> };

function object<T extends Record<string, unknown>>(shape: Shape<T>): Validator<T> {
  return (raw) => {
    if (!isRecord(raw)) return INVALID;
    const out: Record<string, unknown> = {};
    for (const [key, validate] of Object.entries(shape) as [string, Validator<unknown>][]) {
      const cleaned = validate(raw[key]);
      if (cleaned === INVALID) return INVALID;
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out as T;
  };
}

const MAX_EXPORT_CHARS = 21_000_000;
const count: Validator<number> = (raw) =>
  (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 1000 ? raw : INVALID);

const none: Validator<undefined> = (raw) => (raw === undefined || raw === null ? undefined : INVALID);

const connection = object({
  provider: str(64, 1), model: str(256), baseUrl: optional(nullable(str(2048))),
  apiKey: optional(nullable(str(4096))), profileId: optional(str(128)),
});

const promptDraft = object({
  title: str(200, 1), content: str(MAX_TEXT), description: optional(str(2000)),
  tags: optional((raw) => (Array.isArray(raw) && raw.length <= 20 && raw.every((t) => typeof t === 'string' && t.length <= 40)
    ? (raw as string[]) : INVALID)),
  favorite: optional(bool),
});

const partialPromptDraft: Validator<Record<string, unknown>> = (raw) => {
  if (!isRecord(raw)) return INVALID;
  const out: Record<string, unknown> = {};
  for (const key of ['title', 'content', 'description', 'tags', 'favorite']) {
    if (!(key in raw)) continue;
    const field = (promptDraft as unknown as (value: unknown) => unknown)({
      title: 'x', content: '', ...{ [key]: raw[key] },
    });
    if (field === INVALID) return INVALID;
    out[key] = raw[key];
  }
  return out;
};

const desktopStatePatch: Validator<Record<string, unknown>> = (raw) => {
  if (!isRecord(raw)) return INVALID;
  const allowed = ['language', 'enterToSend', 'groupToolRuns', 'maxLiveHosts', 'parkAfterIdleMinutes', 'dismissedHints',
    'recentWorkspaces', 'windows', 'update', 'imageInputOverrides'];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.includes(key)) return INVALID;
    out[key] = value; // `normalizeDesktopState` clamps and rebuilds every field afterwards
  }
  return out;
};

type ValidatorMap = { [K in IpcChannel]: Validator<IpcContract[K]['in']> };

export const IPC_VALIDATORS: ValidatorMap = {
  'app:info': none,
  'config:get': none,
  'config:patch': object({ baseRevision: str(128, 1), patch: plainObject }),
  'config:reveal-key': object({ provider: str(64, 1), profileId: optional(str(128)) }),
  'config:test-connection': connection,
  'config:discover-models': object({
    provider: str(64, 1), baseUrl: optional(nullable(str(2048))),
    apiKey: optional(nullable(str(4096))), profileId: optional(str(128)),
  }),
  'config:open-in-editor': none,
  'config:restore-backup': none,
  'sessions:list': (raw) => (raw === undefined || raw === null ? undefined : object({ query: optional(str(200)) })(raw)),
  'sessions:open': object({
    id: optional(sessionId), cwd: str(4096, 1), branchOf: optional(sessionId), readOnly: optional(bool),
  }),
  'skills:list': (raw) => (raw === undefined || raw === null ? undefined : object({ cwd: optional(str(4096, 1)) })(raw)),
  'sessions:close': object({ id: sessionId }),
  'sessions:park': object({ id: sessionId }),
  'sessions:restart': object({ id: sessionId }),
  'sessions:pin': object({ id: sessionId, pinned: bool }),
  'sessions:remove': object({ id: sessionId, confirm: bool }),
  'sessions:branch': object({ id: sessionId }),
  'workspace:pick': none,
  'workspace:recent': none,
  'prompts:list': none,
  'prompts:create': promptDraft,
  'prompts:update': object({ id: str(128, 1), patch: partialPromptDraft as Validator<IpcContract['prompts:update']['in']['patch']> }),
  'prompts:delete': object({ id: str(128, 1) }),
  'prompts:favorite': object({ id: str(128, 1), favorite: bool }),
  'prompts:use': object({ id: str(128, 1) }),
  'native:open-path': object({ sessionId, relPath: str(4096), reveal: optional(bool) }),
  'native:open-external': object({ url: str(4096, 1) }),
  'native:stat-path': object({ path: str(4096, 1) }),
  'native:read-clipboard-image': none,
  'native:reveal-attachment': object({ sessionId, attachmentId: str(32, 1) }),
  'native:save-attachment': object({ sessionId, attachmentId: str(32, 1), suggestedName: str(300) }),
  'native:notify': object({ title: str(200, 1), body: str(1000), sessionId: optional(sessionId) }),
  'diagnostics:export': none,
  'session:export': object({
    sessionId, suggestedName: str(300), markdown: str(MAX_EXPORT_CHARS), cwd: optional(str(4096, 1)),
  }),
  'native:activity': object({ running: count, waiting: count }),
  'window:set-chrome': object({ theme: (raw) => (isChromeTheme(raw) ? raw : INVALID) }),
  'update:check': none,
  'update:install': none,
  'update:skip-version': object({ version: str(64, 1) }),
  'update:open-download': none,
  'desktop-state:get': none,
  'desktop-state:patch': desktopStatePatch as never,
  'app:quit-plan': none,
  'app:quit-confirmed': object({ stopServices: bool }),
  'app:cancel-quit': none,
};
