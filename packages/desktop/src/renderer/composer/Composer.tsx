/**
 * The message box. Behaviour that is easy to get wrong, and where it is handled:
 *   - IME: while a composition is in progress Enter never sends (`isComposing` / keyCode 229).
 *   - Enter vs Shift+Enter is inverted by the desktop preference `enterToSend`; Ctrl/Cmd+Enter
 *     always sends.
 *   - While a run is live the same box queues (steers) and a separate, labelled Stop appears;
 *     Esc is the host's double-press ladder, and its "hint" answer is shown for the window.
 *   - Drafts live per session in memory (`use-draft`), so switching sessions never loses text.
 *   - A large paste collapses to a chip instead of flooding the textarea.
 */

import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { ipc, platform } from '../api.js';
import { findAttachmentMentions } from '../../shared/attachments.js';
import { useHotkeys } from '../hooks/use-hotkeys.js';
import { pushToast } from '../chat/hooks.js';
import { useT } from '../i18n/index.js';
import { isLargePaste, makeChip, hasContent } from '../lib/chat-drafts.js';
import { describeDroppedPath } from '../lib/drop-paths.js';
import type { SlashItem } from '../lib/chat-slash.js';
import { applyMention, stepIndex } from '../lib/chat-triggers.js';
import { useSession } from '../store/session-store.js';
import { selectAttachmentsEnabled, useUi } from '../store/ui-store.js';
import { AttachmentTray } from './attachments/AttachmentTray.js';
import { ImageSupportBanner } from './attachments/ImageSupportBanner.js';
import { useAttachments } from './attachments/use-attachments.js';
import { useImageMode } from './attachments/use-image-mode.js';
import { cyclePosture } from './ModeChip.js';
import { MENTION_LISTBOX_ID, MentionMenu, mentionOptionId } from './MentionMenu.js';
import { PasteChip } from './PasteChip.js';
import { runSlashItem } from './slash-actions.js';
import { SLASH_LISTBOX_ID, SlashMenu, slashOptionId } from './SlashMenu.js';
import { StatusRow } from './StatusRow.js';
import { useDraft } from './use-draft.js';
import { useMenus, type Menus } from './use-menus.js';
import { onAttachFilesRequest, onComposerIntent } from './composer-bus.js';
import { useSend, useStop } from './use-run-controls.js';
import './composer.css';

/** The desktop preference "Enter sends" (default), read once when the composer mounts. */
function useEnterToSend(): boolean {
  const [enterToSend, setEnterToSend] = useState(true);
  useEffect(() => {
    void ipc('desktop-state:get').then((result) => { if (result.ok) setEnterToSend(result.value.enterToSend); });
  }, []);
  return enterToSend;
}

/** Clipboard formats a normal paste can act on; any of them present means "leave it to the browser". */
const PASTEABLE_TYPES = new Set(['text/plain', 'text/html', 'text/uri-list', 'Files']);

/** True only when the clipboard positively lists its formats and none of them is pasteable. */
function declaresNothingPasteable(data: DataTransfer): boolean {
  return Array.isArray(data.types) && !data.types.some((type) => PASTEABLE_TYPES.has(type));
}

function imageFilesFromItems(data: DataTransfer): File[] {
  return [...(data.items ?? [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function comboboxProps(menus: Menus): Record<string, string | undefined> {
  if (menus.slash) {
    return { 'aria-controls': SLASH_LISTBOX_ID, 'aria-activedescendant': menus.slashItems.length ? slashOptionId(menus.activeIndex) : undefined };
  }
  if (menus.mention && menus.length > 0) {
    return { 'aria-controls': MENTION_LISTBOX_ID, 'aria-activedescendant': mentionOptionId(menus.activeIndex) };
  }
  return {};
}

export function Composer({ sessionId, onSent }: { sessionId: string; onSent(): void }) {
  const t = useT();
  const draft = useDraft(sessionId);
  const { text, chips, caret, inputRef } = draft;
  const running = useSession(sessionId, (mirror) => mirror?.view?.status === 'running');
  const cwd = useSession(sessionId, (mirror) => mirror?.meta?.cwd);
  const enterToSend = useEnterToSend();
  const attachments = useAttachments(sessionId);
  const imageMode = useImageMode(sessionId);
  const attachmentsEnabled = useUi(selectAttachmentsEnabled);
  const menus = useMenus(sessionId, text, caret, attachmentsEnabled ? attachments.items : []);
  const { send, sending, error } = useSend(sessionId, onSent);
  const { escHint, interrupt, stopRun } = useStop(sessionId);
  const [dragging, setDragging] = useState(false);
  const [dragCount, setDragCount] = useState(0);
  const picker = useRef<HTMLInputElement | null>(null);

  const ready = attachments.items.filter((item) => item.status === 'ready');
  const blocked = attachments.blocking;
  const blockedReason = blocked === 'processing' ? t('chat.attach.blocked.processing')
    : blocked === 'error' ? t('chat.attach.blocked.error') : null;
  const canSend = blocked === null && (hasContent({ text, chips }) || ready.length > 0);
  const dangling = [...new Set(findAttachmentMentions(text))]
    .filter((ref) => !attachments.items.some((item) => item.ref === ref));

  const openPicker = (): void => picker.current?.click();
  useEffect(() => onComposerIntent('add-files', openPicker), []);
  useEffect(() => onAttachFilesRequest((target, files) => {
    if (target === sessionId && useUi.getState().attachmentsEnabled) void attachments.add(files, 'picker');
  }), [sessionId, attachments.add]);
  useEffect(() => onComposerIntent('paste-clipboard-image', () => {
    if (useUi.getState().attachmentsEnabled) void attachments.pasteFromClipboardImage({ explicit: true });
  }), [attachments.pasteFromClipboardImage]);
  const hotkeys = useMemo(() => (attachmentsEnabled ? [{ combo: 'mod+u', handler: openPicker }] : []), [attachmentsEnabled]);
  useHotkeys(hotkeys, platform() === 'darwin');

  const submit = async (): Promise<void> => {
    if (blocked !== null) return; // the button says why; Enter must not sneak past it
    const extras = ready.length > 0 ? { attachments: ready, imageMode: imageMode.mode } : undefined;
    if (await send({ text, chips }, extras)) { draft.clear(); attachments.clear(); }
  };

  const pickSlash = (item: SlashItem): void => {
    draft.clear();
    runSlashItem(item, '', sessionId, t);
  };

  const pickMention = (path: string): void => {
    if (menus.mention) draft.applyEdit(applyMention(text, menus.mention, caret, path));
  };

  /** `@image1` is plain text: a menu entry for an attachment just inserts the reference. */
  const pickAttachment = (ref: string): void => pickMention(`@${ref}`);

  /** Arrow keys, Enter/Tab to pick, Esc to close. Returns true when the key was consumed. */
  const onMenuKey = (event: KeyboardEvent): boolean => {
    const step = (delta: number): void => menus.setIndex(stepIndex(menus.activeIndex, delta, menus.length));
    switch (event.key) {
      case 'ArrowDown': step(1); break;
      case 'ArrowUp': step(-1); break;
      case 'Escape': menus.dismiss(); break;
      case 'Enter':
      case 'Tab': {
        const item = menus.slashItems[menus.activeIndex];
        const attached = menus.mentionAttachments[menus.activeIndex];
        const path = menus.mentionState.paths[menus.activeIndex - menus.mentionAttachments.length];
        if (event.shiftKey || (menus.slash ? !item : !attached && !path)) return false;
        if (menus.slash && item) pickSlash(item);
        else if (attached) pickAttachment(attached.ref);
        else if (path) pickMention(path);
        break;
      }
      default: return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return; // IME: Enter belongs to the IME
    if ((menus.slash || menus.mention) && onMenuKey(event)) return;
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      void cyclePosture(sessionId, t);
    } else if (event.key === 'Escape' && running) {
      event.preventDefault();
      void interrupt();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey || (enterToSend && !event.shiftKey && !event.altKey))) {
      event.preventDefault();
      void submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const data = event.clipboardData;
    const pasted = data.getData('text');
    // Read at event time: a switch flipped off must not leave a stale closure still swallowing pastes.
    const enabled = useUi.getState().attachmentsEnabled;
    // A spreadsheet or web copy carries text AND a picture of it: the text wins. Only a
    // clipboard with files and no text (a screenshot, a file copied in the file manager)
    // becomes attachments.
    let files = enabled ? [...(data.files ?? [])] : [];
    // Fallback 1: some sources expose the picture as an item but not in `files`.
    if (enabled && files.length === 0) files = imageFilesFromItems(data);
    if (pasted.trim() === '' && files.length > 0) {
      event.preventDefault();
      void attachments.add(files, 'paste');
      return;
    }
    // Fallback 2: a clipboard that declares NO text or file type at all is a source Chromium did not
    // translate (a bare DIB / private format) - ask the OS. `preventDefault` must be decided NOW, so
    // anything that declares text (even html or a uri-list with no plain text) is left to the browser.
    if (enabled && pasted.trim() === '' && files.length === 0 && declaresNothingPasteable(data)) {
      event.preventDefault();
      void attachments.pasteFromClipboardImage();
      return;
    }
    if (!isLargePaste(pasted)) return;
    event.preventDefault();
    draft.setChips((current) => [...current, makeChip(pasted)]);
  };

  const onDrop = (event: DragEvent): void => {
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length === 0) return; // text drops use the textarea's own behaviour
    event.preventDefault();
    if (!event.shiftKey && useUi.getState().attachmentsEnabled) { // Shift keeps the old behaviour: insert the path as text
      void attachments.add(files, 'drop');
      return;
    }
    // Only the path TEXT is inserted - the engine reads files itself; nothing is uploaded.
    // The sandboxed page cannot see a path, so the preload resolves it (`''` = not a file on disk,
    // e.g. dragged out of a browser tab, in which case the bare name is all there is).
    const parts = files.map((file) => {
      const absolute = window.aragon?.pathForFile?.(file) ?? '';
      if (!absolute) return { text: file.name, outside: false };
      return describeDroppedPath(absolute, cwd ?? '', platform());
    });
    draft.insertText(`${parts.map((part) => part.text).join(' ')} `);
    if (parts.some((part) => part.outside)) pushToast(sessionId, 'info', t('chat.drop.outside'));
  };

  return (
    <div className="composer" data-dragging={dragging ? 'true' : undefined}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
        setDragCount(event.dataTransfer.items?.length ?? 0);
      }}
      onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      {menus.slash ? <SlashMenu items={menus.slashItems} index={menus.activeIndex} onHover={menus.setIndex} onPick={pickSlash} /> : null}
      {menus.mention ? (
        <MentionMenu state={menus.mentionState} attachments={menus.mentionAttachments} index={menus.activeIndex}
          onHover={menus.setIndex} onPick={pickMention} onPickAttachment={pickAttachment} />
      ) : null}
      {escHint ? <div className="esc-hint" role="status">{t('chat.esc.hint')}</div> : null}
      {error ? <div className="composer-error" role="alert">{error}</div> : null}
      <div className="composer-box">
        {dragging ? (
          <div className="att-drop-hint" role="status">
            {dragCount > 0 ? t('chat.attach.dropN', { n: dragCount }) : t('chat.attach.drop')}
          </div>
        ) : null}
        {attachmentsEnabled ? <AttachmentTray sessionId={sessionId} items={attachments.items} mode={imageMode.mode} tokenEstimate={imageMode.input.tokenEstimate}
          onReference={attachments.reference} onRemove={attachments.remove} onRetry={attachments.retry}
          focusInput={() => draft.inputRef.current?.focus()} /> : null}
        {attachmentsEnabled ? (
          <ImageSupportBanner sessionId={sessionId}
            imageCount={attachments.items.filter((item) => item.kind === 'image' && item.status !== 'error').length}
            onRemoveImages={() => attachments.removeMany(attachments.items.filter((item) => item.kind === 'image').map((item) => item.ref))} />
        ) : null}
        {blockedReason ? <div className="att-blocked" role="status">{blockedReason}</div> : null}
        {dangling.length > 0 ? <div className="att-dangling" role="status">{t('chat.attach.dangling', { ref: dangling[0]! })}</div> : null}
        {chips.length > 0 ? (
          <div className="chips">
            {chips.map((chip) => (
              <PasteChip key={chip.id} chip={chip} onRemove={() => draft.setChips((current) => current.filter((item) => item.id !== chip.id))} />
            ))}
          </div>
        ) : null}
        <textarea ref={inputRef} className="composer-input selectable" rows={1} value={text}
          role="combobox" aria-expanded={Boolean(menus.slash || menus.mention)} aria-autocomplete="list" aria-haspopup="listbox"
          aria-label={t('chat.input.label')} placeholder={t('chat.input.placeholder')} {...comboboxProps(menus)}
          onChange={(event) => {
            draft.setText(event.target.value);
            draft.setCaret(event.target.selectionStart);
            menus.reset();
          }}
          onSelect={(event) => draft.setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown} onPaste={onPaste} />
        <StatusRow sessionId={sessionId} running={running} canSend={canSend} blockedReason={blockedReason}
          sending={sending} enterToSend={enterToSend} onSend={() => void submit()} onStop={() => void stopRun()} />
      </div>
      {attachmentsEnabled ? (
        <input ref={picker} type="file" multiple hidden tabIndex={-1} aria-hidden="true" data-testid="attachment-picker"
          onChange={(event) => {
            const picked = [...(event.target.files ?? [])];
            event.target.value = ''; // the same file can be picked again
            if (picked.length > 0) void attachments.add(picked, 'picker');
          }} />
      ) : null}
    </div>
  );
}
