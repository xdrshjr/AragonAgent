/**
 * Create / edit one library prompt. Validation is the engine's own `validatePromptDraft`
 * (limits, tag rules), so the editor cannot accept what the library would refuse; the error
 * lands on the field that owns it.
 */

import { useState } from 'react';
import { parsePromptTags, validatePromptDraft } from '@aragon-agent/tui/model/prompts/validate';
import { PROMPT_LIMITS } from '@aragon-agent/tui/model/prompts/limits';
import type { PromptWriteError } from '@aragon-agent/tui/model/prompts/types';
import { useT } from '../i18n/index.js';
import type { PromptDraftDto, PromptDto } from '../../shared/ipc-contract.js';
import { Dialog } from '../ui/overlay.js';
import { Button, Input, Textarea } from '../ui/primitives.js';

type FieldName = 'title' | 'content' | 'description' | 'tags';

export interface PromptEditorProps {
  prompt: PromptDto | null;
  saving: boolean;
  /** A failure from the main process (it validates again). */
  failure: string | null;
  onSave(draft: PromptDraftDto): void;
  onClose(): void;
}

export function PromptEditor(props: PromptEditorProps) {
  const t = useT();
  const { prompt } = props;
  const [title, setTitle] = useState(prompt?.title ?? '');
  const [content, setContent] = useState(prompt?.content ?? '');
  const [description, setDescription] = useState(prompt?.description ?? '');
  const [tags, setTags] = useState((prompt?.tags ?? []).join(', '));
  const [error, setError] = useState<{ field: FieldName; code: PromptWriteError } | null>(null);

  const submit = (): void => {
    const verdict = validatePromptDraft({
      title, content, description, tags: parsePromptTags(tags), favorite: prompt?.favorite === true,
    });
    if (!verdict.ok) {
      setError({ field: verdict.field, code: verdict.code });
      return;
    }
    setError(null);
    props.onSave({
      title: verdict.input.title,
      content: verdict.input.content,
      description: verdict.input.description ?? '',
      tags: verdict.input.tags ?? [],
      favorite: verdict.input.favorite === true,
    });
  };
  const errorFor = (field: FieldName): string | undefined =>
    (error?.field === field ? t(`settings.prompts.error.${error.code}` as const, { max: PROMPT_LIMITS.contentMaxChars }) : undefined);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }} size="lg"
      title={prompt ? t('settings.prompts.editTitle') : t('settings.prompts.newTitle')}
      actions={<>
        <Button variant="ghost" onClick={props.onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={props.saving} onClick={submit}>{t('common.save')}</Button>
      </>}>
      <div className="pe-grid">
        <div className="pe-field">
          <label className="label" htmlFor="pr-title">{t('settings.prompts.title')}</label>
          <Input id="pr-title" value={title} aria-invalid={error?.field === 'title' ? true : undefined} onChange={(event) => setTitle(event.target.value)} />
          {errorFor('title') ? <div className="error-text" role="alert">{errorFor('title')}</div> : null}
        </div>
        <div className="pe-field">
          <label className="label" htmlFor="pr-desc">{t('settings.prompts.description')}</label>
          <Input id="pr-desc" value={description} onChange={(event) => setDescription(event.target.value)} />
          {errorFor('description') ? <div className="error-text" role="alert">{errorFor('description')}</div> : null}
        </div>
        <div className="pe-field">
          <label className="label" htmlFor="pr-tags">{t('settings.prompts.tags')}</label>
          <Input id="pr-tags" value={tags} onChange={(event) => setTags(event.target.value)} />
          <div className="hint">{t('settings.prompts.tagsHint', { max: PROMPT_LIMITS.maxTags })}</div>
          {errorFor('tags') ? <div className="error-text" role="alert">{errorFor('tags')}</div> : null}
        </div>
        <div className="pe-field pe-wide">
          <label className="label" htmlFor="pr-content">{t('settings.prompts.content')}</label>
          <Textarea id="pr-content" rows={9} value={content} aria-invalid={error?.field === 'content' ? true : undefined}
            onChange={(event) => setContent(event.target.value)} />
          <div className="hint">{t('settings.prompts.contentHint')}</div>
          {errorFor('content') ? <div className="error-text" role="alert">{errorFor('content')}</div> : null}
        </div>
      </div>
      {props.failure ? <p className="set-error" role="alert">{props.failure}</p> : null}
    </Dialog>
  );
}
