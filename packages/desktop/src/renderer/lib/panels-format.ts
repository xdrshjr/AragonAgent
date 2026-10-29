/** Small pure helpers shared by the inspector panels and the settings pages that talk to a session. */

import type { CommandResult } from '../../shared/port-protocol.js';
import type { Translate } from '../i18n/index.js';

export type CommandFailure = Extract<CommandResult, { ok: false }>;

/**
 * A refused or failed command as text the user can act on: the stable code decides the
 * sentence ("the session is busy - try after the run"), and the host's own message follows as
 * detail because it often names the exact reason.
 */
export function commandFailureText(t: Translate, failure: CommandFailure): string {
  const lead = t(`workspace.cmd.${failure.code}` as const);
  return failure.message && failure.message !== lead ? `${lead} ${failure.message}` : lead;
}

/** `0.456` -> `46%`; an unknown window never reads as zero. */
export function percent(fraction: number): string {
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}
