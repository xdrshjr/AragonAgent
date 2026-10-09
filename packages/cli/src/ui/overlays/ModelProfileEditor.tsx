import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import { ADAPTER_PROVIDERS } from '../../config/schema.js';
import { registerSecret } from '../../logging/secret-registry.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';
import { stripPasteFrames } from '../paste-frames.js';
import { stripEnterFrames } from '../enter-frames.js';
import { pickGlyphs } from '../glyphs.js';
import { profileEndpointSummary, useProfileScroll,
  type ProfileFrameProps } from './ModelProfilePicker.js';
import { finishProfileEditor, type ProfileEditorDraft,
  type ModelProfileAction } from './model-profile-state.js';

interface ModelProfileEditorProps extends ProfileFrameProps {
  editor: ProfileEditorDraft;
  users: string;
  error?: string;
  dispatch: React.Dispatch<ModelProfileAction>;
}
const FIELDS = ['name', 'provider', 'model', 'baseUrl', 'credentialMode', 'apiKey'] as const;
const LABELS = ['Name', 'Provider', 'Model', 'Base URL', 'Credential mode', 'API key'];
interface EditorNavigation {
  index: number;
  setIndex: React.Dispatch<React.SetStateAction<number>>;
  retain: boolean;
  count: number;
}

function useEditorInput(props: ModelProfileEditorProps, navigation: EditorNavigation): void {
  const { editor, dispatch } = props;
  const { index, setIndex, retain, count } = navigation;
  function commit(): void {
    const result = finishProfileEditor(editor);
    if (result.field) {
      const at = FIELDS.indexOf(result.field as typeof FIELDS[number]);
      if (at >= 0) setIndex(at);
    }
    dispatch({ type: 'merge-editor' });
  }
  useInput((input, key) => {
    if (props.isActive === false) return;
    if (key.escape) { dispatch({ type: 'cancel-editor' }); return; }
    if (key.upArrow || (key.tab && key.shift)) { setIndex((index - 1 + count) % count); return; }
    if (key.downArrow || key.tab) { setIndex((index + 1) % count); return; }
    if (key.return) {
      if (retain && index === FIELDS.length) dispatch({ type: 'retain-key' });
      else if (index === count - 1) dispatch({ type: 'cancel-editor' });
      else commit();
      return;
    }
    const field = FIELDS[index];
    if (!field || key.ctrl || key.meta) return;
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
  });
}

function buildEditorRows(props: ModelProfileEditorProps,
  navigation: EditorNavigation): React.ReactElement[] {
  const { editor } = props;
  const { index, retain } = navigation;
  const glyphs = pickGlyphs(props.caps);
  const values = FIELDS.map((field) => {
    if (field === 'apiKey') return editor.credentialMode === 'replace'
      ? editor.apiKey ? 'Configured (replacement)' : '(type replacement)'
      : editor.credentialMode === 'keep' ? 'Configured (unchanged)' : 'Shared / environment';
    if (field === 'credentialMode') return editor.credentialMode;
    return editor[field] || (field === 'name' ? '(defaults to model)' : field === 'baseUrl'
      ? '(provider default)' : '(required)');
  });
  const lines = LABELS.map((label, at) => `${label.padEnd(18)}${values[at]}`);
  if (retain) lines.push('Retain key for new endpoint');
  lines.push('Apply to settings draft', 'Cancel editing');
  const rows = lines.map((line, at) => <Text key={at} wrap="truncate"
    color={at === index ? props.theme.accent : props.theme.muted}>
    {at === index ? `${glyphs.caret} ` : '  '}{line}
  </Text>);
  rows.push(<Text key="target" wrap="truncate" color={props.theme.muted}>
    Target: {editor.provider} {profileEndpointSummary(editor.baseUrl)}
  </Text>);
  return rows;
}

/** Replacement key input starts empty; retention across targets is explicit. */
export function ModelProfileEditor(props: ModelProfileEditorProps): React.ReactElement {
  const [index, setIndex] = useState(0);
  const retain = props.editor.endpointChanged && Boolean(props.editor.original.apiKey);
  const navigation = { index, setIndex, retain, count: FIELDS.length + (retain ? 1 : 0) + 2 };
  const offset = useProfileScroll(props, index);
  useEditorInput(props, navigation);
  return <OverlayFrame {...props} rows={buildEditorRows(props, navigation)} scrollOffset={offset}
    title={props.error ?? `Edit profile${props.users ? ` | Used by ${props.users}` : ''}`}
    hint="Enter apply to draft | Esc cancel" />;
}
