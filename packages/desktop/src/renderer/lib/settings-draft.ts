/**
 * Pure draft logic for one settings section: parse what was typed, ask the engine what the
 * file will hold, and build the smallest patch that says so.
 *
 * The patch carries ONLY changed keys (plus keys the engine's cross-field clamp moved as a
 * consequence). The host merges section patches into the stored section, so an untouched key
 * a newer terminal wrote is never rewritten (spec 3.5.3: "diff contains exactly the edited
 * keys").
 */

import type { ConfigViewDto } from '../../shared/config-view.js';
import {
  parseFieldInput, sameValue,
  type FieldError, type FieldSpec, type RawEdits, type SectionSpec,
} from './settings-fields.js';

export type Values = Record<string, unknown>;

export interface AdjustedField {
  key: string;
  typed: unknown;
  saved: unknown;
}

export interface SectionResolution {
  /** Keys whose input could not be parsed; Save is disabled while any exist. */
  errors: Record<string, FieldError>;
  /** What the file will hold for every field (the engine's answer). */
  effective: Values;
  /** Typed values the engine moved (inside the range, or by a dependent field). */
  adjusted: AdjustedField[];
  /** The partial config patch, or null when nothing changed. */
  patch: Record<string, unknown> | null;
  /** Anything edited at all (a parse error still counts: the user has unsaved input). */
  modified: boolean;
}

/** The stored values of a section as the masked config view reports them. */
export function readBase(section: SectionSpec, view: ConfigViewDto | null): Values {
  if (!view) return {};
  const source = view as unknown as Values;
  if (section.configKey) {
    const stored = source[section.configKey];
    return stored && typeof stored === 'object' ? { ...(stored as Values) } : {};
  }
  const out: Values = {};
  for (const field of section.fields) out[field.key] = source[field.key];
  return out;
}

function isVisible(field: FieldSpec, view: ConfigViewDto | null): boolean {
  return field.showIf ? field.showIf(view) : true;
}

export function resolveSection(
  section: SectionSpec,
  view: ConfigViewDto | null,
  edits: RawEdits,
): SectionResolution {
  const base = readBase(section, view);
  const errors: Record<string, FieldError> = {};
  const changed: Values = {};
  for (const field of section.fields) {
    const raw = edits[field.key];
    if (raw === undefined || !isVisible(field, view)) continue;
    const parsed = parseFieldInput(field, raw);
    if (!parsed.ok) errors[field.key] = parsed.error;
    else if (!sameValue(parsed.value, base[field.key])) changed[field.key] = parsed.value;
  }
  const effective = section.clamp({ ...base, ...changed });
  const adjusted: AdjustedField[] = [];
  const body: Values = {};
  for (const key of Object.keys(changed)) {
    body[key] = effective[key];
    if (!sameValue(effective[key], changed[key])) {
      adjusted.push({ key, typed: changed[key], saved: effective[key] });
    }
  }
  // A dependent field the clamp moved (compaction.warnThreshold follows threshold).
  for (const field of section.fields) {
    if (field.key in body || !(field.key in effective)) continue;
    if (!sameValue(effective[field.key], base[field.key]) && Object.keys(changed).length > 0) {
      body[field.key] = effective[field.key];
      adjusted.push({ key: field.key, typed: base[field.key], saved: effective[field.key] });
    }
  }
  const hasBody = Object.keys(body).length > 0;
  const patch = !hasBody ? null : section.configKey ? { [section.configKey]: body } : body;
  return { errors, effective, adjusted, patch, modified: Object.keys(edits).length > 0 };
}

/** Drop edits that equal the stored value, so "modified" only lights up for real changes. */
export function pruneEdits(
  section: SectionSpec,
  view: ConfigViewDto | null,
  edits: RawEdits,
): RawEdits {
  const base = readBase(section, view);
  const out: RawEdits = {};
  for (const field of section.fields) {
    const raw = edits[field.key];
    if (raw === undefined) continue;
    const parsed = parseFieldInput(field, raw);
    if (parsed.ok && sameValue(parsed.value, base[field.key])) continue;
    out[field.key] = raw;
  }
  return out;
}

/** Keys of a config patch, flattened to `section.key` for the conflict diff. */
export function flattenPatch(patch: Record<string, unknown>): Array<{ path: string; value: unknown }> {
  const rows: Array<{ path: string; value: unknown }> = [];
  for (const [key, value] of Object.entries(patch)) {
    const isSection = value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!isSection) {
      rows.push({ path: key, value });
      continue;
    }
    for (const [inner, innerValue] of Object.entries(value as Values)) {
      rows.push({ path: `${key}.${inner}`, value: innerValue });
    }
  }
  return rows;
}

/** Read a possibly nested path from the masked view (`team.maxSubagents`, `theme`). */
export function readPath(view: ConfigViewDto | null, path: string): unknown {
  let node: unknown = view;
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Values)[part];
  }
  return node;
}
