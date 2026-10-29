/**
 * The inspector body: one panel per tab. Each panel owns its own empty state and reads only
 * the slice of the session it needs, so a streaming token re-renders the transcript, not this.
 */

import type { InspectorTab } from '../../shared/desktop-state.js';
import { AgentsPanel } from './AgentsPanel.js';
import { ChangesPanel } from './ChangesPanel.js';
import { ContextPanel } from './ContextPanel.js';
import { GovernancePanel } from './GovernancePanel.js';
import { JobsPanel } from './JobsPanel.js';
import { PlanPanel } from './PlanPanel.js';

export function InspectorPanel({ sessionId, tab }: { sessionId: string; tab: InspectorTab }) {
  switch (tab) {
    case 'changes': return <ChangesPanel sessionId={sessionId} />;
    case 'plan': return <PlanPanel sessionId={sessionId} />;
    case 'agents': return <AgentsPanel sessionId={sessionId} />;
    case 'jobs': return <JobsPanel sessionId={sessionId} />;
    case 'context': return <ContextPanel sessionId={sessionId} />;
    case 'governance': return <GovernancePanel sessionId={sessionId} />;
  }
}
