/**
 * A folded run of finished reads / searches / folder listings (completion spec P4).
 *
 * Folded it is ONE button with a plain-language summary; opened it shows the member `ToolCard`s
 * exactly as they would have appeared on their own (the cards are not touched), under that header.
 * The header stays when opened so the run can be folded again.
 */

import { ChevronRight, Layers } from 'lucide-react';
import { memo } from 'react';
import type { VoiceMode } from '@aragon-agent/tui/ui/tool-voice';
import { useT, type Translate } from '../../i18n/index.js';
import type { GroupedFamily, ToolGroupRow } from '../../lib/chat-tool-groups.js';
import { useUi } from '../../store/ui-store.js';
import { ToolCard } from './ToolCard.js';

const ORDER: readonly GroupedFamily[] = ['read', 'search', 'list'];

/** "Looked at 5 files · searched 2 times · browsed 1 folder": families with a zero count are left out. */
export function summarizeGroup(counts: ToolGroupRow['counts'], t: Translate): string {
  return ORDER
    .filter((family) => counts[family] > 0)
    .map((family) => t(`chat.toolGroup.${family}.${counts[family] === 1 ? 'one' : 'other'}` as const, { n: counts[family] }))
    .join(' · ');
}

function sameMembers(a: ToolGroupRow, b: ToolGroupRow): boolean {
  return a.members.length === b.members.length && a.members.every((member, index) => member === b.members[index]);
}

export const ToolGroupCard = memo(function ToolGroupCard(props: {
  sessionId: string;
  group: ToolGroupRow;
  expandedIds: Record<string, boolean> | undefined;
  voiceMode: VoiceMode;
}) {
  const t = useT();
  const { group, sessionId, voiceMode } = props;
  const summary = summarizeGroup(group.counts, t);
  const action = t(group.expanded ? 'chat.toolGroup.collapse' : 'chat.toolGroup.expand');
  return (
    <div className="tool-group" data-expanded={group.expanded ? 'true' : undefined}>
      <button type="button" className="tool-group-head" aria-expanded={group.expanded}
        aria-label={t('chat.toolGroup.label', { summary, action })}
        onClick={() => useUi.getState().toggleToolGroup(group.id)}>
        <ChevronRight size={14} strokeWidth={1.5} className="chev" aria-hidden="true" />
        <Layers size={14} strokeWidth={1.5} aria-hidden="true" />
        <span className="tool-group-summary">{summary}</span>
      </button>
      {group.expanded ? (
        <div className="tool-group-members">
          {group.members.map((member) => (
            <div key={member.id} data-entry-id={member.id}>
              <ToolCard sessionId={sessionId} entry={member} expanded={props.expandedIds?.[member.id] === true} voiceMode={voiceMode} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}, (prev, next) => prev.sessionId === next.sessionId
  && prev.voiceMode === next.voiceMode
  && prev.group.id === next.group.id
  && prev.group.expanded === next.group.expanded
  && prev.group.counts.read === next.group.counts.read
  && prev.group.counts.search === next.group.counts.search
  && prev.group.counts.list === next.group.counts.list
  && sameMembers(prev.group, next.group)
  // The cards inside only care about their own expanded flag; a collapsed group ignores the map.
  && (!next.group.expanded || prev.expandedIds === next.expandedIds));
