/**
 * Descriptors for the schema-driven settings forms: pure data plus the pure functions that
 * turn what the user typed into what the file will hold.
 *
 * WHY DESCRIPTORS: the config has ~80 keys across a dozen sections, every one with its own
 * clamp in `tui/model/config/schema`. Hand-writing a form per section would duplicate those
 * ranges (and let them drift); here each section names its fields once and asks the engine's
 * own `clamp*Config` what the value will become, so "adjusted to the allowed range" is the
 * engine's answer, not ours.
 */

import type { ConfigViewDto } from '../../shared/config-view.js';
import type { MessageKey } from '../i18n/index.js';

export type FieldUnit = 'ms' | 's';

interface FieldBase {
  key: string;
  labelKey: MessageKey;
  hintKey?: MessageKey;
  /** Switching this flag OFF weakens a safeguard, so the form asks before saving it. */
  danger?: boolean;
  /** Hide the field when this says so (e.g. the fast model comes from a profile). */
  showIf?: (view: ConfigViewDto | null) => boolean;
}

export interface EnumOption {
  value: string;
  labelKey: MessageKey;
}

export type FieldSpec =
  | (FieldBase & { kind: 'bool' })
  | (FieldBase & { kind: 'int' | 'number'; unit?: FieldUnit; zeroKey?: MessageKey; allowZero?: boolean })
  /** A number where `auto` (stored as `null`) is a real value. */
  | (FieldBase & { kind: 'autoInt' })
  | (FieldBase & { kind: 'enum'; options: readonly EnumOption[] })
  | (FieldBase & { kind: 'text' })
  /** One of the saved model profiles, or none. */
  | (FieldBase & { kind: 'profile' });

export type SectionConfigKey =
  | 'team' | 'todo' | 'fast' | 'compaction' | 'retry' | 'governance' | 'skills'
  | 'bash' | 'jobs' | 'prompts' | 'taskSummary' | 'log';

export interface SectionSpec {
  id: string;
  titleKey: MessageKey;
  descKey?: MessageKey;
  /** The config key that holds the section object, or null for top-level scalars. */
  configKey: SectionConfigKey | null;
  fields: readonly FieldSpec[];
  /** The engine's own normaliser: what the file will hold for these raw values. */
  clamp(raw: Record<string, unknown>): Record<string, unknown>;
}

export type FieldError = 'integer' | 'number' | 'choice';

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: FieldError };

/** Raw form input: booleans stay booleans, everything else is the text the user typed. */
export type RawEdits = Record<string, boolean | string>;

const AUTO_WORDS = new Set(['', 'auto', '0']);
const PROBE_HIGH = 1e12;
const PROBE_LOW = -1e12;
/** A probe that comes back this large means "no ceiling". */
const UNBOUNDED_FROM = 1e11;

export function parseFieldInput(field: FieldSpec, raw: boolean | string): ParseResult {
  switch (field.kind) {
    case 'bool':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false, error: 'choice' };
    case 'int': {
      const text = String(raw).trim();
      return /^-?\d+$/.test(text) ? { ok: true, value: Number(text) } : { ok: false, error: 'integer' };
    }
    case 'number': {
      const text = String(raw).trim().replace(',', '.');
      const value = text === '' ? Number.NaN : Number(text);
      return Number.isFinite(value) ? { ok: true, value } : { ok: false, error: 'number' };
    }
    case 'autoInt': {
      const text = String(raw).trim().toLowerCase();
      if (AUTO_WORDS.has(text)) return { ok: true, value: null };
      return /^\d+$/.test(text) ? { ok: true, value: Number(text) } : { ok: false, error: 'integer' };
    }
    case 'enum':
      return field.options.some((option) => option.value === raw)
        ? { ok: true, value: raw } : { ok: false, error: 'choice' };
    case 'profile':
      return { ok: true, value: raw === '' ? null : String(raw) };
    case 'text':
      return { ok: true, value: String(raw).trim() };
  }
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return Object.is(a, b);
}

/** The text a numeric/auto control shows for a stored value. */
export function displayValue(field: FieldSpec, value: unknown): string {
  if (value === null || value === undefined) return field.kind === 'autoInt' ? 'auto' : '';
  return String(value);
}

export interface Bounds {
  min: number | undefined;
  max: number | undefined;
}

/**
 * The allowed range of a numeric field, read from the engine's clamp rather than copied.
 * Probed with the CURRENT merged values, so a dependent range (`maxConcurrent` can never
 * exceed `maxSubagents`) is shown as it applies right now.
 */
export function fieldBounds(
  section: SectionSpec,
  field: FieldSpec,
  merged: Record<string, unknown>,
): Bounds {
  if (field.kind !== 'int' && field.kind !== 'number' && field.kind !== 'autoInt') {
    return { min: undefined, max: undefined };
  }
  const probe = (value: number): number | undefined => {
    const out = section.clamp({ ...merged, [field.key]: value })[field.key];
    return typeof out === 'number' ? out : undefined;
  };
  const low = field.kind === 'number' ? PROBE_LOW : field.kind === 'int' && field.allowZero ? 0 : 1;
  const max = probe(PROBE_HIGH);
  return { min: probe(low), max: max !== undefined && max >= UNBOUNDED_FROM ? undefined : max };
}
