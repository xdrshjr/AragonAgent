/** Turning a failed host command into text a person can act on. Pure given a translate function. */

import type { Translate } from '../i18n/index.js';
import type { CommandResult } from '../../shared/port-protocol.js';

export type CommandFailure = Extract<CommandResult, { ok: false }>;

/**
 * Stable codes get stable, localized wording. For the codes whose host message carries the
 * specifics a user needs (why a send was rejected, what is busy), the message is appended
 * rather than replaced: the code says what KIND of problem it is, the message says which.
 */
export function describeFailure(t: Translate, failure: CommandFailure): string {
  switch (failure.code) {
    case 'timeout': return t('chat.err.timeout');
    case 'port_closed': return t('chat.err.portClosed');
    case 'unsupported': return t('chat.err.unsupported');
    case 'not_applicable': return t('chat.err.notApplicable');
    case 'conflict': return t('chat.err.conflict');
    case 'already_delivered': return t('chat.queued.alreadyDelivered');
    case 'not_found': return t('chat.queued.notFound');
    case 'busy': return `${t('chat.err.busy')} ${failure.message}`.trim();
    case 'rejected': return `${t('chat.err.rejected')} ${failure.message}`.trim();
    case 'invalid_argument': return `${t('chat.err.invalid')} ${failure.message}`.trim();
    case 'attachment_rejected': return `${t('workspace.cmd.attachment_rejected')} ${failure.message}`.trim();
    case 'internal': return `${t('chat.err.internal')} ${failure.message}`.trim();
  }
}
