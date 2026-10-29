/**
 * The probe's VIEW MODEL (model-profile-connection-test §3.2 / §6.3).
 *
 * Pure functions only: the editor's row list, the result sentences, the candidate
 * ordering and the two number formatters. Rendering and input both read
 * `editorRows()`, so "which row am I on" has exactly one definition and inserting a
 * row can no longer shift `apiKey` off index 6 by arithmetic.
 *
 * ASCII ONLY (`ui/` is inside `glyphs.test.ts::inScope`).
 */

import type { ProbeOutcome, ProbeTarget, ModelCandidate, DiscoveryOutcome,
  ModelProbe } from '../../model/agent/model-probe.js';
import { PROBE_LIMITS } from '../../model/agent/model-probe-limits.js';
import { resolveDraftKey } from '../../model/agent/model-probe.js';
import { profileEndpointSummary } from './ModelProfilePicker.js';
import type { ProfileEditorDraft } from './model-profile-state.js';

export const EDITOR_FIELDS = ['name', 'provider', 'model', 'contextWindow', 'baseUrl',
  'credentialMode', 'apiKey'] as const;
export type EditorField = typeof EDITOR_FIELDS[number];
export const EDITOR_LABELS = ['Name', 'Provider', 'Model', 'Context window', 'Base URL',
  'Credential mode', 'API key'];
export type EditorAction = 'retain' | 'test' | 'discover' | 'apply' | 'cancel';

export type EditorRow =
  | { kind: 'field'; field: EditorField; label: string; value: string }
  | { kind: 'action'; action: EditorAction; label: string; value: string }
  | { kind: 'note'; label: string; muted: true }
  | { kind: 'result'; label: string; tone: 'ok' | 'fail' | 'muted' };

/** What the current target's probe looks like to a renderer (editor surface). */
export type ProbeView =
  | { kind: 'idle'; reason: 'no_result' | 'no_key' | 'unavailable' }
  | { kind: 'testing' }
  | { kind: 'result'; outcome: ProbeOutcome };

/** The list page's own surface: a discovery is a page, not a result row. */
export type DiscoveryView =
  | { kind: 'idle' }
  | { kind: 'discovering' }
  | { kind: 'discovery'; outcome: DiscoveryOutcome };

/**
 * The hook's two INDEPENDENT slots, declared here so this module stays React-free.
 *
 * They are separate on purpose: a test outcome and a discovered list describe the
 * same connection but answer different questions, and a single slot would make
 * "run a test, then open the list, then come back" lose the verdict (AC-27).
 */
export type ProbeTestPhase =
  | { phase: 'idle' }
  | { phase: 'testing'; targetId: string }
  | { phase: 'tested'; outcome: ProbeOutcome };

export type ProbeDiscoveryPhase =
  | { phase: 'idle' }
  | { phase: 'discovering'; connectionId: string }
  | { phase: 'discovered'; outcome: DiscoveryOutcome };

export interface ProbeViews {
  test: ProbeView;
  discovery: DiscoveryView;
}

function idleView(hasKey: boolean): ProbeView {
  return { kind: 'idle', reason: hasKey ? 'no_result' : 'no_key' };
}

function hasKey(target: ProbeTarget): boolean {
  return Boolean(target.apiKey && target.apiKey.trim().length > 0);
}

/** Whether pressing a probe action can produce anything at all (AC-12 / AC-15). */
export function canProbe(view: ProbeView): boolean {
  return !(view.kind === 'idle' && (view.reason === 'no_key' || view.reason === 'unavailable'));
}

function testView(test: ProbeTestPhase, target: ProbeTarget, probe?: ModelProbe): ProbeView {
  if (!probe) return { kind: 'idle', reason: 'unavailable' };
  if (test.phase === 'testing') {
    return test.targetId === probe.targetFingerprint(target)
      ? { kind: 'testing' } : idleView(hasKey(target));
  }
  if (test.phase === 'tested') {
    return test.outcome.targetId === probe.targetFingerprint(target)
      ? { kind: 'result', outcome: test.outcome } : idleView(hasKey(target));
  }
  return idleView(hasKey(target));
}

function discoveryView(state: ProbeDiscoveryPhase, target: ProbeTarget,
  probe?: ModelProbe): DiscoveryView {
  if (!probe) return { kind: 'idle' };
  if (state.phase === 'discovering') {
    return state.connectionId === probe.connectionFingerprint(target) ? { kind: 'discovering' }
      : { kind: 'idle' };
  }
  if (state.phase === 'discovered') {
    return state.outcome.connectionId === probe.connectionFingerprint(target)
      ? { kind: 'discovery', outcome: state.outcome } : { kind: 'idle' };
  }
  return { kind: 'idle' };
}

/**
 * Filter both slots down to what the CURRENT target may honestly claim (§4.6).
 *
 * A `OK 812 ms` that describes a model the user has since edited is worse than no
 * result at all, so a fingerprint mismatch degrades to `idle` - no effect, no
 * reset call, no cross-page synchronisation.
 */
export function visibleProbeViews(test: ProbeTestPhase, discovery: ProbeDiscoveryPhase,
  target: ProbeTarget, probe?: ModelProbe): ProbeViews {
  return { test: testView(test, target, probe), discovery: discoveryView(discovery, target, probe) };
}

/** The exact target a draft would use - the resolved key included (§4.2.1). */
export function editorProbeTarget(editor: ProfileEditorDraft,
  apiKeys: Record<string, string | undefined>): ProbeTarget {
  return {
    provider: editor.provider,
    model: editor.model,
    baseUrl: editor.baseUrl.trim().length > 0 ? editor.baseUrl.trim() : null,
    apiKey: resolveDraftKey({ credentialMode: editor.credentialMode, draftKey: editor.apiKey,
      existingKey: editor.original.apiKey, sharedKey: apiKeys[editor.provider] }),
  };
}

/** `812 ms` / `1.4 s` - one decimal only once a second has passed. */
export function latencyLabel(ms: number): string {
  const safe = Number.isFinite(ms) && ms >= 0 ? ms : 0;
  return safe < 1000 ? `${Math.round(safe)} ms` : `${(safe / 1000).toFixed(1)} s`;
}

/** `128K` / `1M` / `auto` - `auto` when the vendor did not report a window. */
export function windowLabel(window?: number): string {
  if (!window || !Number.isFinite(window)) return 'auto';
  if (window >= 1_000_000) {
    const millions = window / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (window >= 1000) return `${Math.round(window / 1000)}K`;
  return String(Math.round(window));
}

/**
 * Clean and order a discovered list: one row per id, and the model the draft
 * already names first, so "which one am I on" is answerable without scrolling.
 */
export function rankCandidates(models: readonly ModelCandidate[],
  currentModel: string): ModelCandidate[] {
  const seen = new Set<string>();
  const unique: ModelCandidate[] = [];
  for (const model of models) {
    if (model.id.length === 0 || seen.has(model.id)) continue;
    seen.add(model.id);
    unique.push(model);
  }
  const wanted = currentModel.trim().toLowerCase();
  if (wanted.length === 0) return unique;
  const matches = (model: ModelCandidate): boolean => model.id.toLowerCase() === wanted;
  const prefixed = (model: ModelCandidate): boolean => model.id.toLowerCase().startsWith(wanted);
  return [...unique.filter(matches), ...unique.filter((model) => !matches(model) && prefixed(model)),
    ...unique.filter((model) => !matches(model) && !prefixed(model))];
}

function usagePart(outcome: ProbeOutcome): string {
  if (!outcome.usage) return '';
  return ` | ${outcome.usage.inputTokens} in / ${outcome.usage.outputTokens} out`;
}

function fixLine(outcome: ProbeOutcome): string | undefined {
  if (outcome.kind === 'auth') return 'Fix: edit API key, or set Credential mode to Shared.';
  if (outcome.kind !== 'model_not_found') return undefined;
  const reach = outcome.availableModels;
  return `Fix: choose Discover models.${reach === undefined ? ''
    : ` This key can reach ${reach} models.`}`;
}

function resultLines(outcome: ProbeOutcome, target: ProbeTarget): string[] {
  const name = `${target.provider}:${target.model.trim()}`;
  if (outcome.ok) {
    const head = `Last test: ${name} OK in ${latencyLabel(outcome.latencyMs)}${usagePart(outcome)}`;
    const reply = outcome.reply ? `Reply: "${outcome.reply}"` : undefined;
    const reach = outcome.reply || outcome.availableModels === undefined ? undefined
      : `This key can reach ${outcome.availableModels} models.`;
    const second = reply ?? reach;
    return second ? [head, second] : [head];
  }
  const head = `Last test: FAILED - ${outcome.detail ?? 'The connection test failed.'}`;
  const fix = fixLine(outcome);
  return fix ? [head, fix] : [head];
}

/** At most TWO rows: the verdict, then what to do about it (§3.1 / D-11). */
export function probeLines(view: ProbeView, target: ProbeTarget): string[] {
  if (view.kind === 'result') return resultLines(view.outcome, target).slice(0, 2);
  if (view.kind === 'idle') {
    if (view.reason === 'unavailable') return ['Connection test is unavailable in this session.'];
    if (view.reason === 'no_key') return ['No key yet: set API key, or use Credential mode Shared.'];
    return ['Not tested for this profile yet.'];
  }
  return [];
}

/** Colour for the result rows; the status WORDS carry the meaning without colour. */
export function probeTone(view: ProbeView): 'ok' | 'fail' | 'muted' {
  if (view.kind !== 'result') return 'muted';
  return view.outcome.ok ? 'ok' : 'fail';
}

function fieldValue(editor: ProfileEditorDraft, field: EditorField): string {
  if (field === 'apiKey') {
    if (editor.credentialMode === 'replace') {
      return editor.apiKey ? 'Configured (replacement)' : '(type replacement)';
    }
    return editor.credentialMode === 'keep' ? 'Configured (unchanged)' : 'Shared / environment';
  }
  if (field === 'credentialMode') return editor.credentialMode;
  return editor[field] || (field === 'name' ? '(defaults to model)'
    : field === 'contextWindow' ? '(auto)' : field === 'baseUrl'
      ? '(provider default)' : '(required)');
}

function actionValue(action: EditorAction, view: ProbeView): string {
  if (action === 'retain' || action === 'apply' || action === 'cancel') return '';
  if (view.kind === 'idle' && view.reason === 'unavailable') return '(unavailable)';
  if (view.kind === 'idle' && view.reason === 'no_key') return '(no key)';
  if (action === 'test' && view.kind === 'testing') return 'testing...';
  return action === 'test' ? 'Enter or Ctrl+R' : 'Enter or Ctrl+F';
}

function actionRow(action: EditorAction, label: string, view: ProbeView): EditorRow {
  return { kind: 'action', action, label, value: actionValue(action, view) };
}

export interface EditorRowsInput {
  editor: ProfileEditorDraft;
  retain: boolean;
  probe: ProbeView;
  target: ProbeTarget;
  /** The `Window applies ...` honesty line for a Fast-only entry (§3.2 / RV-P1-7). */
  fastOnly?: boolean;
}

/** THE single source of the editor's rows - fields, actions, notes AND results. */
export function editorRows(input: EditorRowsInput): EditorRow[] {
  const { editor, retain, probe, target } = input;
  const rows: EditorRow[] = EDITOR_FIELDS.map((field, at) => ({ kind: 'field' as const, field,
    label: EDITOR_LABELS[at]!, value: fieldValue(editor, field) }));
  if (retain) rows.push(actionRow('retain', 'Retain key for new endpoint', probe));
  rows.push(actionRow('test', 'Test connection', probe),
    actionRow('discover', 'Discover models', probe),
    actionRow('apply', 'Apply to settings draft', probe),
    actionRow('cancel', 'Cancel editing', probe));
  rows.push({ kind: 'note', muted: true,
    label: `Target: ${editor.provider} ${profileEndpointSummary(editor.baseUrl)}` });
  if (input.fastOnly) {
    rows.push({ kind: 'note', muted: true,
      label: 'Window applies when this profile is bound as Main.' });
  }
  const tone = probeTone(probe);
  for (const line of probeLines(probe, target)) {
    rows.push({ kind: 'result', label: line, tone });
  }
  return rows;
}

/** Rows the cursor can land on; index arithmetic now derives from the row model. */
export function isFocusable(row: EditorRow): boolean {
  return row.kind === 'field' || row.kind === 'action';
}

/** The focusable rows, in order - the index space `useProfileScroll` follows. */
export function focusableRows(rows: readonly EditorRow[]): EditorRow[] {
  return rows.filter(isFocusable);
}

/** Result rows currently on screen, so the viewport can be widened to include them. */
export function resultRowCount(rows: readonly EditorRow[]): number {
  return rows.filter((row) => row.kind === 'result').length;
}

/** Longest id shown in one list row, inside the 40-column budget. */
export const LIST_ID_CHARS = 28;

/** A model's one-line name, bounded by `maxNameChars`. */
export function clipName(name: string): string {
  const points = [...name];
  return points.length <= PROBE_LIMITS.maxNameChars ? name
    : `${points.slice(0, PROBE_LIMITS.maxNameChars - 3).join('')}...`;
}
