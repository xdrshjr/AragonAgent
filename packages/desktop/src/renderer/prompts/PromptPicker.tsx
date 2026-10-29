/**
 * The prompt picker (Ctrl/Cmd+P): fuzzy search with favourites first, an optional
 * `{{variable}}` form, then the text goes into the composer.
 *
 * ESCAPE ORDER. The picker sits above whatever opened it, and Esc elsewhere in the app means
 * "interrupt the run" or "close a panel". While the picker is open it takes the key at the
 * WINDOW's capture phase and stops it there, so closing the picker never also interrupts a run
 * or closes a dialog underneath. It reports itself through `useUi().promptPickerOpen` for any
 * handler that wants to check.
 */

import { Star } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { searchPrompts, viewOrder } from '@aragon-agent/tui/model/prompts/search';
import { PROMPT_PICKER_LIMITS } from '@aragon-agent/tui/model/prompts/limits';
import type { QuickPrompt } from '@aragon-agent/tui/model/prompts/types';
import { useT } from '../i18n/index.js';
import { useConfig } from '../store/config-store.js';
import { useUi } from '../store/ui-store.js';
import type { PromptDto } from '../../shared/ipc-contract.js';
import { Dialog } from '../ui/overlay.js';
import { Button, Input } from '../ui/primitives.js';
import { extractVariables } from './prompt-vars.js';
import { PromptFillForm } from './PromptFillForm.js';
import { usePrompts } from './prompts-store.js';
import './prompts.css';

const toQuick = (prompt: PromptDto): QuickPrompt => ({
  id: prompt.id, title: prompt.title, content: prompt.content, useCount: prompt.useCount,
  createdAt: prompt.updatedAt, updatedAt: prompt.updatedAt,
  ...(prompt.description ? { description: prompt.description } : {}),
  ...(prompt.tags ? { tags: prompt.tags } : {}),
  ...(prompt.favorite ? { favorite: true } : {}),
});

/** Favourites first, then the engine's fuzzy order. */
export function orderForPicker(prompts: readonly PromptDto[], query: string): QuickPrompt[] {
  const library = prompts.map(toQuick);
  return query.trim() === '' ? viewOrder(library, 'favorite') : searchPrompts(library, query).map((hit) => hit.prompt);
}

function useEscapeFirst(onEscape: () => void): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      // Esc that cancels an IME composition belongs to the IME: swallow it, close nothing.
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      onEscape();
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [onEscape]);
}

function PickerBody({ onClose }: { onClose(): void }) {
  const t = useT();
  const prompts = usePrompts((state) => state.prompts);
  const loaded = usePrompts((state) => state.loaded);
  const enabled = useConfig((state) => state.result?.view?.prompts.enabled) !== false;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [filling, setFilling] = useState<QuickPrompt | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => { void usePrompts.getState().refresh(); }, []);
  useEscapeFirst(onClose);

  const results = useMemo(() => orderForPicker(prompts, query), [prompts, query]);
  const current = results[Math.min(active, Math.max(0, results.length - 1))];

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active, results]);

  const finish = (prompt: QuickPrompt, text: string): void => {
    useUi.getState().insertIntoComposer(text);
    void usePrompts.getState().markUsed(prompt.id);
    onClose();
  };
  const choose = (prompt: QuickPrompt): void => {
    if (extractVariables(prompt.content).length === 0) finish(prompt, prompt.content);
    else setFilling(prompt);
  };

  const onKey = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => Math.min(results.length - 1, value + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
    else if (event.key === 'Enter' && current) { event.preventDefault(); choose(current); }
  };

  if (!enabled) {
    return <p className="pp-note" role="status">{t('workspace.prompts.disabled')}</p>;
  }
  if (filling) {
    return <PromptFillForm title={filling.title} content={filling.content} onBack={() => setFilling(null)}
      onSubmit={(text) => finish(filling, text)} />;
  }
  return (
    <div className="pp">
      <Input role="combobox" aria-expanded="true" aria-controls="pp-list" aria-activedescendant={current ? `pp-opt-${current.id}` : undefined}
        aria-label={t('workspace.prompts.search')} placeholder={t('workspace.prompts.search')} value={query} autoFocus autoComplete="off"
        maxLength={PROMPT_PICKER_LIMITS.queryMaxChars}
        onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKey} />
      {!loaded ? <p className="pp-note" role="status">{t('common.loading')}</p> : results.length === 0 ? (
        <p className="pp-note" role="status">{query ? t('workspace.prompts.noMatch', { query }) : t('workspace.prompts.empty')}</p>
      ) : (
        <ul id="pp-list" ref={listRef} className="pp-list" role="listbox" aria-label={t('workspace.prompts.title')}>
          {results.map((prompt, index) => (
            <li key={prompt.id} id={`pp-opt-${prompt.id}`} role="option" aria-selected={index === active} className="pp-item"
              data-active={index === active} onMouseMove={() => setActive(index)} onClick={() => choose(prompt)}>
              <span className="pp-item-title">
                {prompt.favorite ? <Star size={12} aria-label={t('workspace.prompts.favoriteMark')} className="pp-star" /> : null}
                {prompt.title}
                {extractVariables(prompt.content).length > 0 ? <span className="badge">{t('workspace.prompts.hasVariables')}</span> : null}
              </span>
              <span className="pp-item-sub">{prompt.description || prompt.content.split('\n')[0]}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="pp-hint">{t('workspace.prompts.keys')}</p>
      <div className="dialog-actions"><Button variant="ghost" onClick={onClose}>{t('common.close')}</Button></div>
    </div>
  );
}

export function PromptPicker() {
  const t = useT();
  const open = useUi((state) => state.promptPickerOpen);
  const setOpen = useUi((state) => state.setPromptPickerOpen);
  // Unmounted while closed: every opening starts with an empty query and the list step.
  if (!open) return null;
  return (
    <Dialog open onOpenChange={(next) => { if (!next) setOpen(false); }} size="lg"
      title={t('workspace.prompts.title')} description={t('workspace.prompts.desc')}>
      <PickerBody onClose={() => setOpen(false)} />
    </Dialog>
  );
}
