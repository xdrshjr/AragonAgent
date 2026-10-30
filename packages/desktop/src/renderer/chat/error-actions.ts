/** What the buttons on an actionable error notice do. */

import type { Translate } from '../i18n/index.js';
import { findRetryText, type ErrorAction } from '../lib/chat-errors.js';
import { describeFailure } from '../lib/chat-results.js';
import { sessionStore } from '../store/session-store.js';
import { useUi } from '../store/ui-store.js';
import type { AttachmentReadValue } from '../../shared/attachments.js';
import type { AttachmentDraft } from '../composer/attachments/attachment-draft-store.js';
import { draftFromRead } from '../composer/attachments/restore-withdrawn.js';
import { overrideKey, writeImageOverride } from '../composer/attachments/image-input.js';
import { pushActionToast } from './action-toast-store.js';
import { pushToast } from './hooks.js';

/**
 * The provider refused a picture: fetch the last message's attachments back from the host and
 * send it again with the pictures as file paths. Like Retry, this adds a new user entry (the host
 * has no "replace the failed turn" command); the failed one stays above it as history.
 */
async function resendImagesAsPaths(sessionId: string, t: Translate): Promise<boolean> {
  const entries = sessionStore.get(sessionId)?.view?.entries ?? [];
  const last = [...entries].reverse().find((entry) => entry.kind === 'user');
  const metas = last?.kind === 'user' && !last.invocation ? last.attachments ?? [] : [];
  if (last?.kind !== 'user' || !metas.some((meta) => meta.kind === 'image' && meta.sent === 'inline')) {
    pushToast(sessionId, 'warn', t('chat.attach.noImagesToResend'));
    return false;
  }
  const drafts: AttachmentDraft[] = [];
  for (const meta of metas) {
    const answer = await sessionStore.command(sessionId, { c: 'attachment.read', id: meta.id });
    const draft = answer.ok ? draftFromRead(meta, answer.value as AttachmentReadValue) : null;
    if (!draft) {
      pushToast(sessionId, 'warn', t('chat.attach.restoreFailed', { n: 1 }));
      return false;
    }
    drafts.push(draft);
  }
  const result = await sessionStore.sendMessage(sessionId, last.text, drafts, 'path');
  if (!result.ok) pushToast(sessionId, 'error', describeFailure(t, result));
  return result.ok;
}

async function resubmit(sessionId: string, t: Translate): Promise<boolean> {
  const text = findRetryText(sessionStore.get(sessionId)?.view?.entries ?? []);
  if (text === null) {
    pushToast(sessionId, 'warn', t('chat.error.noRetry'));
    return false;
  }
  const result = await sessionStore.command(sessionId, { c: 'submit', text });
  if (!result.ok) pushToast(sessionId, 'error', describeFailure(t, result));
  return result.ok;
}

/** Whether the newest user message went out with inline pictures (what a path resend can replace). */
function lastSentInlineImages(sessionId: string): boolean {
  const entries = sessionStore.get(sessionId)?.view?.entries ?? [];
  const last = [...entries].reverse().find((entry) => entry.kind === 'user');
  return last?.kind === 'user' && !last.invocation
    && (last.attachments ?? []).some((meta) => meta.kind === 'image' && meta.sent === 'inline');
}

/**
 * Record the user's decision about a model and tell the host, in that order, and wait for the
 * host's answer. The host builds the next request from what it was last told, so resending before
 * the acknowledgement could still send pictures to a model that was just marked blind.
 * Returns whether the host accepted it.
 */
async function setModelImageOverride(
  sessionId: string, key: string, value: 'off' | null, t: Translate,
): Promise<boolean> {
  await writeImageOverride(key, value);
  const ack = await sessionStore.command(sessionId, { c: 'image.override', key, value });
  if (!ack.ok) pushToast(sessionId, 'error', describeFailure(t, ack));
  return ack.ok;
}

/** The "I can't see images" recovery for a model that is not known to read them. */
async function recoverFromRefusedImages(sessionId: string, t: Translate): Promise<void> {
  const meta = sessionStore.get(sessionId)?.meta;
  if (!meta?.provider || !meta.model) {
    await resendImagesAsPaths(sessionId, t); // no model identity to remember: the one-off resend
    return;
  }
  const key = overrideKey(meta.provider, meta.model);
  if (!(await setModelImageOverride(sessionId, key, 'off', t))) return;
  // The override is the user's intent and stays even if the resend fails; the toast below is how
  // they take it back. A message with pictures goes again as paths, anything else is a plain retry
  // (the host now drops history pictures from the request).
  pushActionToast(sessionId, {
    level: 'info',
    text: t('chat.error.markedNoImages', { model: meta.model }),
    action: { label: t('chat.attach.undo'), onRun: () => { void setModelImageOverride(sessionId, key, null, t); } },
  });
  if (lastSentInlineImages(sessionId)) await resendImagesAsPaths(sessionId, t);
  else await resubmit(sessionId, t);
}

/** One-off resend for a model the catalog says reads images; the permanent choice is offered after. */
async function resendOnceThenOfferOverride(sessionId: string, t: Translate): Promise<void> {
  if (!(await resendImagesAsPaths(sessionId, t))) return;
  const meta = sessionStore.get(sessionId)?.meta;
  if (!meta?.provider || !meta.model) return;
  const key = overrideKey(meta.provider, meta.model);
  pushActionToast(sessionId, {
    level: 'info',
    text: t('chat.error.pathsSentOnce'),
    action: { label: t('chat.error.neverImages'), onRun: () => { void setModelImageOverride(sessionId, key, 'off', t); } },
  });
}

export async function runErrorAction(sessionId: string, action: ErrorAction, t: Translate): Promise<void> {
  if (action === 'open-models') {
    useUi.getState().openSettings('models');
    return;
  }
  if (action === 'no-image-retry') {
    await recoverFromRefusedImages(sessionId, t);
    return;
  }
  if (action === 'send-as-paths') {
    await resendOnceThenOfferOverride(sessionId, t);
    return;
  }
  if (action === 'compact-retry') {
    const compacted = await sessionStore.command(sessionId, { c: 'compact' });
    if (!compacted.ok) {
      pushToast(sessionId, 'error', describeFailure(t, compacted));
      return;
    }
  }
  await resubmit(sessionId, t);
}
