import React, { useState } from 'react';
import { Text, useInput, type Key } from 'ink';
import { ADAPTER_PROVIDERS } from '../../config/schema.js';
import { registerSecret } from '../../logging/secret-registry.js';
import type { ProbeTarget } from '../../agent/model-probe.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';
import { stripPasteFrames } from '../paste-frames.js';
import { stripEnterFrames } from '../enter-frames.js';
import { pickGlyphs } from '../glyphs.js';
import { useProfileScroll, type ProfileFrameProps } from './ModelProfilePicker.js';
import { finishProfileEditor, type ProfileEditorDraft,
  type ModelProfileAction } from './model-profile-state.js';
import { EDITOR_FIELDS, editorRows, editorProbeTarget, focusableRows,
  resultRowCount, type EditorRow, type ProbeView } from './model-probe-view.js';

interface ModelProfileEditorProps extends ProfileFrameProps {
  editor: ProfileEditorDraft;
  users: string;
  error?: string;
  dispatch: React.Dispatch<ModelProfileAction>;
  /**
   * The rendered probe state and its three intents. ALL OPTIONAL: a standalone or
   * embedded mount has no probe port, and the two action rows then read
   * `(unavailable)` instead of pretending to work (§6.1 / AC-15).
   */
  probeView?: ProbeView;
  probeBusy?: boolean;
  probeTarget?: ProbeTarget;
  onTest?: () => void;
  onDiscover?: () => void;
  onCancelProbe?: () => void;
}

/** Where the cursor is plus the row it names - the only input vocabulary. */
interface EditorFocus {
  index: number;
  setIndex: React.Dispatch<React.SetStateAction<number>>;
  count: number;
  rows: EditorRow[];
  focusable: EditorRow[];
}

function useEditorInput(props: ModelProfileEditorProps, focus: EditorFocus): void {
  const { editor, dispatch } = props;
  const { index, setIndex, count, focusable } = focus;
  function commit(): void {
    const result = finishProfileEditor(editor);
    if (result.field) {
      // Field rows are the first focusables, in `EDITOR_FIELDS` order, so the jump an
      // invalid field asks for is a lookup rather than an offset guess.
      const at = EDITOR_FIELDS.indexOf(result.field as typeof EDITOR_FIELDS[number]);
      if (at >= 0) setIndex(at);
    }
    dispatch({ type: 'merge-editor' });
  }
  function activate(row: EditorRow | undefined): void {
    if (!row) return;
    if (row.kind === 'field') { commit(); return; }
    if (row.kind !== 'action') return;
    if (row.action === 'retain') dispatch({ type: 'retain-key' });
    if (row.action === 'test') props.onTest?.();
    if (row.action === 'discover') props.onDiscover?.();
    if (row.action === 'apply') commit();
    if (row.action === 'cancel') dispatch({ type: 'cancel-editor' });
  }
  function editField(row: EditorRow, input: string, key: Key): void {
    if (row.kind !== 'field') return;
    const field = row.field;
    if (field === 'provider' || field === 'credentialMode') {
      if (!key.leftArrow && !key.rightArrow) return;
      const options: readonly string[] = field === 'provider' ? ADAPTER_PROVIDERS
        : editor.original.apiKey && !editor.endpointChanged ? ['keep', 'replace', 'shared']
          : ['shared', 'replace'];
      const current = options.indexOf(editor[field]);
      dispatch({ type: 'editor-field', field,
        value: options[(current + (key.leftArrow ? -1 : 1) + options.length) % options.length]! });
      return;
    }
    if (field === 'apiKey' && editor.credentialMode !== 'replace') return;
    const text = stripPasteFrames(stripEnterFrames(input));
    const value = key.backspace || key.delete ? [...editor[field]].slice(0, -1).join('')
      : editor[field] + text;
    if (field === 'apiKey') registerSecret(value);
    if (key.backspace || key.delete || text) dispatch({ type: 'editor-field', field, value });
  }
  useInput((input, key) => {
    if (props.isActive === false) return;
    // Accelerators work on EVERY row (§3.3): the action rows are the primary entry,
    // these are only the shortcut. Both keys are unused by `App`'s global branch.
    if (key.ctrl && input === 'r') { props.onTest?.(); return; }
    if (key.ctrl && input === 'f') { props.onDiscover?.(); return; }
    if (key.escape) {
      // THREE-LEVEL Esc (§3.4): a probe in flight is cancelled first and the draft
      // survives; only the second press discards the form.
      if (props.probeBusy) { props.onCancelProbe?.(); return; }
      dispatch({ type: 'cancel-editor' });
      return;
    }
    if (key.upArrow || (key.tab && key.shift)) { setIndex((index - 1 + count) % count); return; }
    if (key.downArrow || key.tab) { setIndex((index + 1) % count); return; }
    if (key.return) { activate(focusable[index]); return; }
    if (key.ctrl || key.meta) return;
    const row = focusable[index];
    if (row) editField(row, input, key);
  });
}

function rowColor(props: ModelProfileEditorProps, row: EditorRow): string | undefined {
  if (row.kind === 'result') {
    return row.tone === 'ok' ? props.theme.toolDone
      : row.tone === 'fail' ? props.theme.noticeError : props.theme.muted;
  }
  return undefined;
}

function buildRows(props: ModelProfileEditorProps, focus: EditorFocus): React.ReactElement[] {
  const glyphs = pickGlyphs(props.caps);
  const focused = focus.focusable[focus.index];
  return focus.rows.map((row, at) => {
    if (row.kind === 'note') {
      return <Text key={at} wrap="truncate" color={props.theme.muted}>{row.label}</Text>;
    }
    if (row.kind === 'result') {
      return <Text key={at} wrap="truncate" color={rowColor(props, row)}>{row.label}</Text>;
    }
    const line = row.value.length > 0 ? `${row.label.padEnd(18)}${row.value}` : row.label;
    const isFocused = row === focused;
    return <Text key={at} wrap="truncate"
      color={isFocused ? props.theme.accent : props.theme.muted}>
      {isFocused ? `${glyphs.caret} ` : '  '}{line}
    </Text>;
  });
}

function editorHint(props: ModelProfileEditorProps): string {
  if (props.probeBusy) return 'Esc cancel the probe | draft is kept';
  return 'Enter apply to draft | Ctrl+R test | Ctrl+F discover | Esc cancel';
}

/**
 * The profile form. Row semantics come from `editorRows()` - never from index
 * arithmetic - so `apiKey` stays at index 6 and the two probe actions sit at the end
 * of the action block, after `retain` (P0-1 / I-4).
 */
export function ModelProfileEditor(props: ModelProfileEditorProps): React.ReactElement {
  const [index, setIndex] = useState(0);
  const editor = props.editor;
  const retain = editor.endpointChanged && Boolean(editor.original.apiKey);
  const probe = props.probeView ?? { kind: 'idle' as const, reason: 'unavailable' as const };
  const target = props.probeTarget ?? editorProbeTarget(editor, {});
  const rows = editorRows({ editor, retain, probe, target, fastOnly: props.users === 'Fast' });
  const focusable = focusableRows(rows);
  const count = Math.max(1, focusable.length);
  const clamped = Math.min(index, count - 1);
  // The result rows sit BELOW the action block, so following the focused row alone
  // would leave the verdict off-screen right after the user asked for it (§4.9 / AC-21).
  // How many action rows there are comes from the row model, never from a constant: a
  // sixth action would otherwise move this window boundary onto a FIELD row.
  const actionRows = focusable.filter((row) => row.kind === 'action').length;
  const results = resultRowCount(rows);
  const inActions = clamped >= count - actionRows;
  const viewFocus = results > 0 && inActions ? Math.max(clamped, rows.length - 1) : clamped;
  const offset = useProfileScroll(props, viewFocus);
  useEditorInput(props, { index: clamped, setIndex, count, rows, focusable });
  return <OverlayFrame {...props} rows={buildRows(props, { index: clamped, setIndex, count,
    rows, focusable })} scrollOffset={offset}
    title={props.error ?? `Edit profile${props.users ? ` | Used by ${props.users}` : ''}`}
    hint={editorHint(props)} />;
}
