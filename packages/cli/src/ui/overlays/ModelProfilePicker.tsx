import React, { useEffect, useState } from 'react';
import { Text, useInput } from 'ink';
import stringWidth from 'string-width';
import type { ModelProfile, ModelProfilesConfig, ModelRole } from '../../config/model-profiles.js';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame, overlayBodyRows } from '../layout/OverlayFrame.js';
import { stripPasteFrames } from '../paste-frames.js';
import { stripEnterFrames } from '../enter-frames.js';
import { profileUsers } from './model-profile-state.js';

export interface ProfileFrameProps {
  isActive?: boolean;
  theme: Theme;
  caps: TermCapabilities;
  cols: number;
  maxRows: number;
  scrollOffset: number;
  onScrollClamp?: (offset: number) => void;
}
/** Move focus into view while accepting App's independent wheel/page scrolling. */
export function useProfileScroll(props: ProfileFrameProps, focus: number): number {
  const [offset, setOffset] = useState(0);
  useEffect(() => { props.onScrollClamp?.(0); }, []);
  useEffect(() => { setOffset(props.scrollOffset); }, [props.scrollOffset]);
  useEffect(() => {
    const height = overlayBodyRows(props.maxRows, props.cols);
    const next = focus < offset ? focus : focus >= offset + height ? focus - height + 1 : offset;
    if (next !== offset) { setOffset(next); props.onScrollClamp?.(next); }
  }, [focus, props.maxRows, props.cols]);
  return offset;
}
/** Cut by terminal columns, preserving surrogate pairs and wide names. */
export function clipProfileText(value: string, columns: number): string {
  let result = '';
  for (const point of value) {
    if (stringWidth(result + point) > Math.max(0, columns)) break;
    result += point;
  }
  return result;
}
function uniqueId(profile: ModelProfile, entries: ModelProfile[]): string {
  let length = Math.min(8, profile.id.length);
  while (length < profile.id.length && entries.some((other) => other.id !== profile.id
    && other.id.slice(0, length) === profile.id.slice(0, length))) length++;
  return profile.id.slice(0, length);
}
export function profileEndpointSummary(baseUrl: string | null): string {
  if (!baseUrl) return 'Default URL';
  try {
    const url = new URL(baseUrl);
    return url.username || url.password || url.search || url.hash ? 'Invalid URL' : url.host;
  } catch { return 'Invalid URL'; }
}
function host(profile: ModelProfile): string {
  return profileEndpointSummary(profile.baseUrl);
}
interface ModelProfilePickerProps extends ProfileFrameProps {
  profiles: ModelProfilesConfig;
  savedProfiles?: ModelProfilesConfig;
  role: ModelRole;
  manager?: boolean;
  error?: string;
  apiKeys: Record<string, string | undefined>;
  customProfile?: ModelProfile;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  onEdit: (profile: ModelProfile) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onCancel: () => void;
}
function usePickerState(props: ModelProfilePickerProps) {
  const [index, setIndex] = useState(0);
  const [selectedId, setSelectedId] = useState(props.profiles.entries[0]?.id);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const searchable = props.profiles.entries.length > 8;
  const entries = props.profiles.entries.filter((entry) =>
    `${entry.name} ${entry.provider} ${entry.model}`.toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()));
  const actions = props.manager ? ['New', 'Edit', 'Duplicate', 'Delete'] : ['Create profile'];
  const prefix = props.manager ? 0 : 1;
  const count = entries.length + prefix + actions.length;
  const cursor = Math.min(index, count - 1);
  const focused = entries[cursor - prefix];
  const selected = props.profiles.entries.find((entry) => entry.id === selectedId);
  const offset = useProfileScroll(props, cursor + (searchable ? 1 : 0));
  useEffect(() => { if (focused) setSelectedId(focused.id); }, [focused?.id]);
  return { setIndex, query, setQuery, searching, setSearching, searchable, entries,
    actions, prefix, count, cursor, focused, selected, offset };
}

type PickerState = ReturnType<typeof usePickerState>;

function usePickerInput(props: ModelProfilePickerProps, state: PickerState): void {
  const { cursor, focused, selected, actions, prefix, entries, count, searching,
    searchable, setIndex, setQuery, setSearching } = state;
  function activate(): void {
    if (!props.manager && cursor === 0) { props.onSelect(null); return; }
    if (focused) {
      if (props.manager) setIndex(prefix + entries.length + 1);
      else props.onSelect(focused.id);
      return;
    }
    const action = actions[cursor - prefix - entries.length];
    if (action === 'New' || action === 'Create profile') props.onCreate();
    if (action === 'Edit' && selected) props.onEdit(selected);
    if (action === 'Duplicate' && selected) props.onDuplicate(selected.id);
    if (action === 'Delete' && selected) props.onDelete(selected.id);
  }
  useInput((input, key) => {
    if (props.isActive === false) return;
    if (key.escape) { if (searching) setSearching(false); else props.onCancel(); return; }
    if (searching) {
      if (key.return || key.downArrow || key.tab) { setSearching(false); return; }
      if (key.backspace || key.delete) setQuery((value) => [...value].slice(0, -1).join(''));
      else if (input && !key.ctrl && !key.meta) {
        setQuery((value) => value + stripPasteFrames(stripEnterFrames(input)));
      }
      setIndex(0);
      return;
    }
    if (key.upArrow || (key.tab && key.shift)) setIndex((cursor - 1 + count) % count);
    else if (key.downArrow || key.tab) setIndex((cursor + 1) % count);
    else if (key.return) activate();
    else if (input === '/' && searchable) setSearching(true);
  });
}

function profilePickerLabel(props: ModelProfilePickerProps, entry: ModelProfile): string {
  const saved = profileUsers(props.savedProfiles, entry.id);
  const checked = props.profiles[`${props.role}Id`] === entry.id ? '[Selected] ' : '';
  const duplicate = props.profiles.entries.some((other) => other.id !== entry.id
    && other.name === entry.name);
  const identity = duplicate ? `#${uniqueId(entry, props.profiles.entries)} ` : '';
  const detail = duplicate ? ` ${host(entry)}` : '';
  return `${identity}${checked}${entry.name}  ${entry.provider}:${entry.model}${detail}`
    + (saved ? ` [${saved}]` : '');
}

function buildPickerRows(props: ModelProfilePickerProps, state: PickerState): React.ReactElement[] {
  const { entries, actions, cursor, searching, searchable, query, focused, selected } = state;
  const glyphs = pickGlyphs(props.caps);
  const lines: string[] = [];
  if (!props.manager) lines.push('Current custom');
  lines.push(...entries.map((entry) => profilePickerLabel(props, entry)));
  lines.push(...actions);
  const rows = lines.map((line, row) => <Text key={row} wrap="truncate"
    color={row === cursor ? props.theme.accent : props.theme.muted}>
    {`${row === cursor && !searching ? glyphs.caret : ' '} `}
    {clipProfileText(line, props.cols - 8)}
  </Text>);
  if (searchable) rows.unshift(<Text key="search" wrap="truncate" color={props.theme.primary}>
    {searching ? `${glyphs.caret} ` : '  '}Search: {query || '(/ to search)'}
  </Text>);
  const detail = !props.manager && cursor === 0 ? props.customProfile : focused ?? selected;
  if (detail) {
    rows.push(<Text key="detail" wrap="truncate" color={props.theme.muted}>
      {detail.provider}:{detail.model || '(not set)'} {host(detail)}
      {detail === props.customProfile ? '' : ` #${detail.id}`}
    </Text>);
    rows.push(<Text key="key" wrap="truncate" color={props.theme.muted}>
      {detail.apiKey ? 'Profile key: Configured'
        : props.apiKeys[detail.provider] ? 'Shared / environment: Configured' : 'Missing API key'}
    </Text>);
  }
  return rows;
}

/** Profile selection and explicit management actions share one input owner. */
export function ModelProfilePicker(props: ModelProfilePickerProps): React.ReactElement {
  const state = usePickerState(props);
  usePickerInput(props, state);
  return <OverlayFrame {...props} title={props.error ?? (props.manager ? 'Manage profiles'
    : `${props.role === 'main' ? 'Main' : 'Fast'} profile`)} rows={buildPickerRows(props, state)}
    scrollOffset={state.searching ? 0 : state.offset}
    hint={state.searching ? 'Type search | Enter done | Esc back'
      : 'Enter select/action | Esc back'} />;
}
