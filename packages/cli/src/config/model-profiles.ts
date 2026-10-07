import { randomUUID } from 'node:crypto';
import { ADAPTER_PROVIDERS } from './schema.js';

export type ModelRole = 'main' | 'fast';
export interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
}
export interface ModelProfilesConfig {
  version: 1;
  entries: ModelProfile[];
  mainId: string | null;
  fastId: string | null;
}
export interface ProfileBindingState {
  selectedId: string | null;
  appliedId: string | null;
  overriddenFields: Array<'provider' | 'model' | 'baseUrl'>;
  invalid: boolean;
}
export interface ModelProfilesRuntime {
  main: ProfileBindingState;
  fast: ProfileBindingState;
}
export interface ProfileValidationIssue {
  path: string;
  code: 'invalid' | 'duplicate_id' | 'missing_reference' | 'unsupported_version';
  message: string;
}
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Return a fresh empty library without initiating a disk migration. */
export function emptyModelProfiles(): ModelProfilesConfig {
  return { version: 1, entries: [], mainId: null, fastId: null };
}
/** Return independently mutable role state. */
export function emptyModelProfileState(invalid = false): ModelProfilesRuntime {
  const binding = (): ProfileBindingState => ({ selectedId: null, appliedId: null,
    overriddenFields: [], invalid });
  return { main: binding(), fast: binding() };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validText(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && !CONTROL.test(value)
    && (allowEmpty || value.trim().length > 0) && [...value.trim()].length <= max;
}
function validUrl(value: unknown): boolean {
  if (value === null || (typeof value === 'string' && !value.trim())) return true;
  if (typeof value !== 'string' || CONTROL.test(value)) return false;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname)
      && !url.username && !url.password && !value.includes('?') && !value.includes('#');
  } catch { return false; }
}
function validateEntry(value: unknown, index: number): ProfileValidationIssue[] {
  const path = `modelProfiles.entries[${index}]`;
  const invalid = (field: string, message: string): ProfileValidationIssue => ({
    path: field ? `${path}.${field}` : path, code: 'invalid', message,
  });
  if (!isRecord(value)) return [invalid('', 'Profile must be an object.')];
  const issues: ProfileValidationIssue[] = [];
  if (!validText(value.id, 128)) issues.push(invalid('id', 'ID must have 1-128 safe characters.'));
  if (!validText(value.name, 80, true)) {
    issues.push(invalid('name', 'Name must have at most 80 safe characters.'));
  }
  if (!(ADAPTER_PROVIDERS as readonly unknown[]).includes(value.provider)) {
    issues.push(invalid('provider', 'Select a supported provider.'));
  }
  if (!validText(value.model, 256)) {
    issues.push(invalid('model', 'Model must have 1-256 safe characters.'));
  }
  if (!validUrl(value.baseUrl)) {
    issues.push(invalid('baseUrl', 'Use an HTTP(S) URL without credentials, query or fragment.'));
  }
  if (value.apiKey !== null && !validText(value.apiKey, 8192)) {
    issues.push(invalid('apiKey', 'Enter a nonempty key up to 8192 safe characters.'));
  }
  return issues;
}
/** Validate untrusted input; diagnostics never include supplied values. */
export function validateModelProfiles(value: unknown): ProfileValidationIssue[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return [{ path: 'modelProfiles', code: 'invalid',
    message: 'Model profiles must be an object. Repair with aragon config edit.' }];
  if (value.version !== 1) return [{ path: 'modelProfiles.version',
    code: 'unsupported_version', message: 'Unsupported model profiles version.' }];
  if (!Array.isArray(value.entries) || value.entries.length > 200) {
    return [{ path: 'modelProfiles.entries', code: 'invalid',
      message: 'Use an array with at most 200 profiles; remove unused profiles to add more.' }];
  }
  const issues = value.entries.flatMap(validateEntry);
  const ids = new Set<string>();
  value.entries.forEach((entry: unknown, index: number) => {
    if (!isRecord(entry) || typeof entry.id !== 'string') return;
    if (ids.has(entry.id)) issues.push({ path: `modelProfiles.entries[${index}].id`,
      code: 'duplicate_id', message: 'Profile IDs must be unique.' });
    ids.add(entry.id);
  });
  for (const field of ['mainId', 'fastId'] as const) {
    if (value[field] !== null && (typeof value[field] !== 'string' || !ids.has(value[field]))) {
      issues.push({ path: `modelProfiles.${field}`, code: 'missing_reference',
        message: 'Select an existing profile or Current custom.' });
    }
  }
  return issues;
}
/** Normalize a valid library into a safe field whitelist; throws a fixed error if invalid. */
export function normalizeModelProfiles(value: unknown): ModelProfilesConfig {
  if (validateModelProfiles(value).length) throw new Error('Invalid model profiles.');
  if (value === undefined) return emptyModelProfiles();
  const library = value as ModelProfilesConfig;
  return { version: 1, mainId: library.mainId, fastId: library.fastId,
    entries: library.entries.map((entry) => ({ id: entry.id, name: entry.name.trim()
      || [...entry.model.trim()].slice(0, 80).join(''), provider: entry.provider,
    model: entry.model.trim(), baseUrl: entry.baseUrl?.trim() || null,
    apiKey: entry.apiKey?.trim() || null })) };
}
/** Create an entry with a stable UUID and a frozen default name. */
export function createModelProfile(input: Omit<ModelProfile, 'id'>): ModelProfile {
  const entry = { ...input, id: randomUUID() };
  return normalizeModelProfiles({ ...emptyModelProfiles(), entries: [entry] }).entries[0]!;
}
/** Duplicate the current draft entry, including its explicitly edited credential. */
export function duplicateModelProfile(entry: ModelProfile): ModelProfile {
  return { ...entry, id: randomUUID(), name: `${[...entry.name].slice(0, 73).join('')} (copy)` };
}
/** Remove an unused entry; binding references must be changed explicitly first. */
export function removeModelProfile(library: ModelProfilesConfig, id: string): ModelProfilesConfig {
  if (library.mainId === id || library.fastId === id) throw new Error('Profile is still in use.');
  return { ...library, entries: library.entries.filter((entry) => entry.id !== id) };
}
