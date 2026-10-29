/**
 * Localised wording for the engine's closed vocabularies (compaction phases, triggers, modes and
 * rejection reasons; governance postures).
 *
 * The engine's own labels are English constants meant for the terminal. Showing them in a Chinese
 * window is the half-translated look this file prevents. Every table is a `Record` over the
 * engine's union type, so a member added upstream is a COMPILE error here until it has a key; the
 * rejection reasons are open-ended strings upstream, so `engine-labels.test.ts` checks the exported
 * code list against the table instead. A value nobody translated falls back to the engine's text.
 */

import type { CompactionMode, CompactionPhase, CompactionUiTrigger } from '@aragon-agent/tui/model/compaction/types';
import { compactionReasonCode, describeCompactionReason } from '@aragon-agent/tui/model/compaction/reason-text';
import type { Posture } from '@aragon-agent/tui/model/governance/posture';
import { lookupMessage, type MessageKey, type Translate } from '../i18n/index.js';

export const POSTURE_KEYS = {
  build: 'engine.posture.build',
  plan: 'engine.posture.plan',
  govern: 'engine.posture.govern',
  plan_govern: 'engine.posture.plan_govern',
} as const satisfies Record<Posture, MessageKey>;

export const COMPACTION_PHASE_KEYS = {
  planning: 'engine.compaction.phase.planning',
  digesting: 'engine.compaction.phase.digesting',
  summarizing: 'engine.compaction.phase.summarizing',
  validating: 'engine.compaction.phase.validating',
  applying: 'engine.compaction.phase.applying',
} as const satisfies Record<CompactionPhase, MessageKey>;

export const COMPACTION_TRIGGER_KEYS = {
  pressure: 'engine.compaction.trigger.pressure',
  overflow: 'engine.compaction.trigger.overflow',
  manual: 'engine.compaction.trigger.manual',
} as const satisfies Record<CompactionUiTrigger, MessageKey>;

export const COMPACTION_MODE_KEYS = {
  summarized: 'engine.compaction.mode.summarized',
  truncated: 'engine.compaction.mode.truncated',
  relieved: 'engine.compaction.mode.relieved',
  none: 'engine.compaction.mode.none',
} as const satisfies Record<CompactionMode, MessageKey>;

export const postureLabel = (t: Translate, posture: Posture): string => t(POSTURE_KEYS[posture]);
export const phaseLabel = (t: Translate, phase: CompactionPhase): string => t(COMPACTION_PHASE_KEYS[phase]);
export const triggerLabel = (t: Translate, trigger: CompactionUiTrigger): string => t(COMPACTION_TRIGGER_KEYS[trigger]);
export const modeLabel = (t: Translate, mode: CompactionMode): string => t(COMPACTION_MODE_KEYS[mode]);

export interface LocalisedReason {
  text: string;
  action?: string;
}

/** The sentence for a compaction rejection reason; an unknown code keeps the engine's own wording. */
export function reasonLabel(reason: string): LocalisedReason {
  const code = compactionReasonCode(reason);
  const text = lookupMessage(`engine.compaction.reason.${code}`);
  if (text === null) return describeCompactionReason(reason);
  const action = lookupMessage(`engine.compaction.reason.${code}.action`);
  return action === null ? { text } : { text, action };
}
