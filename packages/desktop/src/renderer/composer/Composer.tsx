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

import { useEffect, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { ipc, platform } from '../api.js';
import { pushToast } from '../chat/hooks.js';
import { useT } from '../i18n/index.js';
import { isLargePaste, makeChip, hasContent } from '../lib/chat-drafts.js';
import { describeDroppedPath } from '../lib/drop-paths.js';
import type { SlashItem } from '../lib/chat-slash.js';
import { applyMention, stepIndex } from '../lib/chat-triggers.js';
import { useSession } from '../store/session-store.js';
import { cyclePosture } from './ModeChip.js';
import { MENTION_LISTBOX_ID, MentionMenu, mentionOptionId } from './MentionMenu.js';
import { PasteChip } from './PasteChip.js';
import { runSlashItem } from './slash-actions.js';
import { SLASH_LISTBOX_ID, SlashMenu, slashOptionId } from './SlashMenu.js';
import { StatusRow } from './StatusRow.js';
import { useDraft } from './use-draft.js';
import { useMenus, type Menus } from './use-menus.js';
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

function comboboxProps(menus: Menus): Record<string, string | undefined> {
  if (menus.slash) {
    return { 'aria-controls': SLASH_LISTBOX_ID, 'aria-activedescendant': menus.slashItems.length ? slashOptionId(menus.activeIndex) : undefined };
  }
  if (menus.mention && menus.mentionState.paths.length > 0) {
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
  const menus = useMenus(sessionId, text, caret);
  const { send, sending, error } = useSend(sessionId, onSent);
  const { escHint, interrupt, stopRun } = useStop(sessionId);
  const [dragging, setDragging] = useState(false);

  const submit = async (): Promise<void> => {
    if (await send({ text, chips })) draft.clear();
  };

  const pickSlash = (item: SlashItem): void => {
    draft.clear();
    runSlashItem(item, '', sessionId, t);
  };

  const pickMention = (path: string): void => {
    if (menus.mention) draft.applyEdit(applyMention(text, menus.mention, caret, path));
  };

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
        const path = menus.mentionState.paths[menus.activeIndex];
        if (event.shiftKey || (menus.slash ? !item : !path)) return false;
        if (menus.slash && item) pickSlash(item);
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
    const pasted = event.clipboardData.getData('text');
    if (!isLargePaste(pasted)) return;
    event.preventDefault();
    draft.setChips((current) => [...current, makeChip(pasted)]);
  };

  const onDrop = (event: DragEvent): void => {
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length === 0) return; // text drops use the textarea's own behaviour
    event.preventDefault();
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
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      {menus.slash ? <SlashMenu items={menus.slashItems} index={menus.activeIndex} onHover={menus.setIndex} onPick={pickSlash} /> : null}
      {menus.mention ? <MentionMenu state={menus.mentionState} index={menus.activeIndex} onHover={menus.setIndex} onPick={pickMention} /> : null}
      {escHint ? <div className="esc-hint" role="status">{t('chat.esc.hint')}</div> : null}
      {error ? <div className="composer-error" role="alert">{error}</div> : null}
      <div className="composer-box">
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
        <StatusRow sessionId={sessionId} running={running} canSend={hasContent({ text, chips })} sending={sending}
          enterToSend={enterToSend} onSend={() => void submit()} onStop={() => void stopRun()} />
      </div>
    </div>
  );
}
