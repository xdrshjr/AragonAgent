import React, { useEffect, useState } from 'react';
import { Text, useInput } from 'ink';
import type { ModelCandidate } from '../../model/agent/model-probe.js';
import { PROBE_LIMITS } from '../../model/agent/model-probe-limits.js';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';
import { stripPasteFrames } from '../paste-frames.js';
import { stripEnterFrames } from '../enter-frames.js';
import { clipProfileText, useProfileScroll, type ProfileFrameProps }
  from './ModelProfilePicker.js';
import { rankCandidates, windowLabel, clipName, LIST_ID_CHARS, type DiscoveryView }
  from './model-probe-view.js';

interface ModelDiscoveryListProps extends ProfileFrameProps {
  provider: string;
  /** The draft's current model: the cursor starts on it when the list has it. */
  currentModel: string;
  view: DiscoveryView;
  busy: boolean;
  onChoose: (model: string) => void;
  onRetry: () => void;
  onBack: () => void;
  onCancelProbe?: () => void;
}

function matches(candidate: ModelCandidate, query: string): boolean {
  const needle = query.toLocaleLowerCase();
  return candidate.id.toLocaleLowerCase().includes(needle)
    || candidate.name.toLocaleLowerCase().includes(needle);
}

/** One row: id column, name column, window right-aligned inside the frame budget. */
function listRowText(candidate: ModelCandidate, cols: number): string {
  const width = Math.max(20, cols - 8);
  const label = windowLabel(candidate.contextWindow);
  const idWidth = Math.max(10, Math.min(LIST_ID_CHARS, width - label.length - 14));
  const nameWidth = Math.max(4, width - idWidth - label.length - 2);
  const id = [...candidate.id].slice(0, idWidth).join('').padEnd(idWidth);
  // `clipName` caps the NAME COLUMN itself, so a vendor that ships a paragraph in
  // `name` cannot push the window label out of a wide frame either.
  const name = [...clipName(candidate.name)].slice(0, nameWidth).join('').padEnd(nameWidth);
  return clipProfileText(`${id} ${name} ${label}`, width);
}

/** What the page says when there is no row to select. */
function emptyLines(busy: boolean, provider: string, view: DiscoveryView): string[] {
  if (busy) return [`Discovering ${provider} models...`];
  if (view.kind === 'discovery' && !view.outcome.ok) {
    return [view.outcome.detail ?? 'The model list could not be fetched.',
      'Fix: check the base URL and key, then press r to retry.'];
  }
  if (view.kind === 'discovery') {
    return ['No models returned. Press r to retry, Esc to go back.',
      'Test the connection for a precise reason.'];
  }
  return ['No models discovered yet. Press r to retry, Esc to go back.'];
}

interface ListView {
  query: string;
  shown: ModelCandidate[];
  cursor: number;
  searchable: boolean;
  searching: boolean;
  /** Whether the truncation notice is rendered below the last candidate. */
  truncated: boolean;
}

function buildRows(props: ModelDiscoveryListProps, view: ListView,
  glyphs: ReturnType<typeof pickGlyphs>): React.ReactElement[] {
  const rows: React.ReactElement[] = [];
  if (view.searchable) {
    rows.push(<Text key="search" wrap="truncate" color={props.theme.primary}>
      {view.searching ? `${glyphs.caret} ` : '  '}Search: {view.query || '(/ to search)'}
    </Text>);
  }
  if (view.shown.length === 0) {
    const lines = view.query.length > 0
      ? [`No model matches "${view.query}". Esc clears the search.`]
      : emptyLines(props.busy, props.provider, props.view);
    for (const line of lines) {
      rows.push(<Text key={`empty-${rows.length}`} wrap="truncate"
        color={props.theme.muted}>{line}</Text>);
    }
  }
  view.shown.forEach((candidate, at) => {
    const focused = at === view.cursor && !view.searching;
    rows.push(<Text key={candidate.id} wrap="truncate"
      color={at === view.cursor ? props.theme.accent : props.theme.muted}>
      {focused ? `${glyphs.caret} ` : '  '}{listRowText(candidate, props.cols)}
    </Text>);
  });
  if (view.truncated) {
    const total = props.view.kind === 'discovery'
      ? props.view.outcome.total ?? view.shown.length : view.shown.length;
    rows.push(<Text key="truncated" wrap="truncate" color={props.theme.muted}>
      {`Showing first ${PROBE_LIMITS.maxListedModels} of ${total}. Narrow with search.`}
    </Text>);
  }
  return rows;
}

/**
 * The discovered-model page (model-profile-connection-test §3.5).
 *
 * Pure display plus input: it receives the discovery outcome and three intents and
 * issues no request itself. No spinner - the census of animated sites is a closed
 * list, and this overlay can be open while a run is in flight.
 */
export function ModelDiscoveryList(props: ModelDiscoveryListProps): React.ReactElement {
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const glyphs = pickGlyphs(props.caps);
  const candidates: ModelCandidate[] = props.view.kind === 'discovery'
    ? props.view.outcome.models : [];
  const ranked = rankCandidates(candidates, props.currentModel);
  const shown = query.length > 0 ? ranked.filter((item) => matches(item, query)) : ranked;
  const searchable = ranked.length > PROBE_LIMITS.searchThreshold;
  const cursor = shown.length > 0 ? Math.min(index, shown.length - 1) : 0;
  // The truncation notice is one row BELOW the last candidate, and `useProfileScroll`
  // only guarantees the FOCUSED row is visible - the same blind spot that hid the
  // editor's result rows (RV-P1-3). Standing on the last row therefore widens the
  // window by one, or `Showing first 400 of ...` could never be read at all.
  const truncatedNotice = props.view.kind === 'discovery' && props.view.outcome.truncated
    && shown.length > 0;
  const revealNotice = truncatedNotice && cursor >= shown.length - 1;
  const offset = useProfileScroll(props,
    cursor + (searchable ? 1 : 0) + (revealNotice ? 1 : 0));
  // Arrival, not every render: when the outcome lands, put the cursor on the model the
  // draft already names, so "which one am I on" is answerable without scrolling.
  const arrival = props.view.kind === 'discovery'
    ? `${props.view.outcome.connectionId}|${ranked.length}` : 'none';
  useEffect(() => {
    const at = ranked.findIndex((item) => item.id === props.currentModel.trim());
    setIndex(at > 0 ? at : 0);
  }, [arrival]);
  const move = (delta: number): void => {
    if (shown.length > 0) setIndex((cursor + delta + shown.length) % shown.length);
  };
  useInput((input, key) => {
    if (props.isActive === false) return;
    if (key.escape) {
      if (searching) { setSearching(false); setQuery(''); setIndex(0); return; }
      if (props.busy) { props.onCancelProbe?.(); return; }
      props.onBack();
      return;
    }
    if (key.upArrow || (key.tab && key.shift)) { move(-1); return; }
    if (key.downArrow || key.tab) { move(1); return; }
    if (key.return) {
      const picked = shown[cursor];
      if (picked) props.onChoose(picked.id);
      return;
    }
    if (searching) {
      if (key.backspace || key.delete) {
        setQuery((value) => [...value].slice(0, -1).join(''));
        setIndex(0);
      } else if (input && !key.ctrl && !key.meta) {
        setQuery((value) => value + stripPasteFrames(stripEnterFrames(input)));
        setIndex(0);
      }
      return;
    }
    if (input === '/' && searchable) { setSearching(true); setIndex(0); return; }
    // `r` retries ONLY outside the search state: sharing the key with the query would
    // turn one typo into a network request (§3.5 / D-16).
    if (!key.ctrl && !key.meta && input === 'r') props.onRetry();
  });
  const hint = props.busy ? 'Esc cancel'
    : searching ? 'Type search | Enter choose | Esc back'
      : `Enter choose${searchable ? ' | / search' : ''} | r retry | Esc back`;
  return <OverlayFrame {...props} scrollOffset={offset} hint={hint}
    rows={buildRows(props, { query, shown, cursor, searchable, searching,
      truncated: truncatedNotice }, glyphs)}
    title={`Models | ${props.provider} (${shown.length})`} />;
}
