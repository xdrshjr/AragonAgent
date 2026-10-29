/**
 * The `ask_user` wizard: one question per step, single or multiple choice, with the engine's
 * synthetic "Other" option opening a free-text field (<= 2000 characters).
 *
 * Closing it any way (Esc, Cancel) answers `cancelled: true` - the same "the user declined" the
 * terminal sends. "Skip and explain" answers every question with the Other option and one
 * free-text explanation instead, so the agent hears WHY the question did not fit.
 */

import { useState } from 'react';
import type { NormalizedQuestion } from '@aragon-agent/tui/model/tools/human-input';
import { useT } from '../i18n/index.js';
import { sessionStore } from '../store/session-store.js';
import { ANSWER_LIMITS, type HostResponse } from '../../shared/port-protocol.js';
import { Badge, Button, Textarea } from '../ui/primitives.js';
import { Dialog } from '../ui/overlay.js';
import type { RequestOf } from './request-types.js';
import { useEscape } from './use-escape.js';
import './approvals.css';

type AskRequest = RequestOf<'ask-user'>;
interface Choice { picked: string[]; custom: string }
type Choices = Record<string, Choice>;

const EMPTY: Choice = { picked: [], custom: '' };

function otherLabel(question: NormalizedQuestion): string | undefined {
  return question.options.find((option) => option.isOther)?.label;
}

/** A question is answered when something is picked, and "Other" has text behind it. */
export function isAnswered(question: NormalizedQuestion, choice: Choice | undefined): boolean {
  const { picked, custom } = choice ?? EMPTY;
  if (picked.length === 0) return false;
  const other = otherLabel(question);
  return other === undefined || !picked.includes(other) || custom.trim() !== '';
}

function toAnswers(questions: NormalizedQuestion[], choices: Choices): Extract<HostResponse, { k: 'ask-user' }>['answers'] {
  return questions.map((question) => {
    const { picked, custom } = choices[question.id] ?? EMPTY;
    const other = otherLabel(question);
    const usesOther = other !== undefined && picked.includes(other);
    return { id: question.id, selected: picked, custom: usesOther ? custom.slice(0, ANSWER_LIMITS.freeText) : null };
  });
}

function QuestionStep(props: {
  question: NormalizedQuestion; choice: Choice; onChange(choice: Choice): void;
}) {
  const t = useT();
  const { question, choice } = props;
  const other = otherLabel(question);
  const toggle = (label: string): void => {
    if (!question.allowMultiple) return props.onChange({ ...choice, picked: [label] });
    const picked = choice.picked.includes(label) ? choice.picked.filter((item) => item !== label) : [...choice.picked, label];
    props.onChange({ ...choice, picked });
  };
  return (
    <fieldset className="ask-question">
      <legend>
        <Badge>{question.header}</Badge> <span>{question.question}</span>
      </legend>
      <p className="hint">{question.allowMultiple ? t('chat.ask.multi') : t('chat.ask.single')}</p>
      {question.options.map((option) => (
        <label key={option.label} className="ask-option" data-checked={choice.picked.includes(option.label) ? 'true' : undefined}>
          <input type={question.allowMultiple ? 'checkbox' : 'radio'} name={question.id}
            checked={choice.picked.includes(option.label)} onChange={() => toggle(option.label)} />
          <span className="ask-option-text">
            <span>{option.label}{option.recommended ? <Badge tone="brand">{t('chat.ask.recommended')}</Badge> : null}</span>
            {option.description ? <span className="hint">{option.description}</span> : null}
          </span>
        </label>
      ))}
      {other !== undefined && choice.picked.includes(other) ? (
        <Textarea rows={3} maxLength={ANSWER_LIMITS.freeText} value={choice.custom} aria-label={t('chat.ask.otherLabel')}
          placeholder={t('chat.ask.otherPlaceholder')} autoFocus
          onChange={(event) => props.onChange({ ...choice, custom: event.target.value })} />
      ) : null}
    </fieldset>
  );
}

export function AskUserWizard({ sessionId, request }: { sessionId: string; request: AskRequest }) {
  const t = useT();
  const { questions } = request.req;
  const [step, setStep] = useState(0);
  const [choices, setChoices] = useState<Choices>({});
  const [explain, setExplain] = useState<string | null>(null);
  const question = questions[Math.min(step, questions.length - 1)]!;
  const last = step >= questions.length - 1;

  const send = (response: Extract<HostResponse, { k: 'ask-user' }>): void => {
    sessionStore.answer(sessionId, request.id, response);
  };
  const cancel = (): void => send({ k: 'ask-user', cancelled: true, answers: [] });
  const submitChoices = (): void => send({ k: 'ask-user', cancelled: false, answers: toAnswers(questions, choices) });
  const submitExplanation = (): void => {
    const text = (explain ?? '').trim().slice(0, ANSWER_LIMITS.freeText);
    const answers = questions.flatMap((item) => {
      const label = otherLabel(item);
      return label === undefined ? [] : [{ id: item.id, selected: [label], custom: text }];
    });
    send({ k: 'ask-user', cancelled: answers.length === 0, answers });
  };
  useEscape(cancel);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) cancel(); }} dismissible={false} size="lg"
      title={t('chat.ask.title')} description={t('chat.ask.step', { n: step + 1, total: questions.length })}
      actions={explain === null ? (
        <>
          <Button variant="ghost" onClick={cancel}>{t('common.cancel')}</Button>
          <Button variant="ghost" onClick={() => setExplain('')}>{t('chat.ask.skip')}</Button>
          <Button disabled={step === 0} onClick={() => setStep(step - 1)}>{t('common.back')}</Button>
          {last
            ? <Button variant="primary" disabled={!questions.every((item) => isAnswered(item, choices[item.id]))} onClick={submitChoices}>{t('chat.ask.submit')}</Button>
            : <Button variant="primary" disabled={!isAnswered(question, choices[question.id])} onClick={() => setStep(step + 1)}>{t('common.next')}</Button>}
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={cancel}>{t('common.cancel')}</Button>
          <Button onClick={() => setExplain(null)}>{t('common.back')}</Button>
          <Button variant="primary" disabled={explain.trim() === ''} onClick={submitExplanation}>{t('chat.ask.sendExplanation')}</Button>
        </>
      )}>
      <div>
        {explain === null ? (
          <QuestionStep question={question} choice={choices[question.id] ?? EMPTY}
            onChange={(choice) => setChoices((current) => ({ ...current, [question.id]: choice }))} />
        ) : (
          <label className="ask-explain">
            <span>{t('chat.ask.explainLabel')}</span>
            <Textarea rows={5} maxLength={ANSWER_LIMITS.freeText} value={explain} autoFocus
              onChange={(event) => setExplain(event.target.value)} />
          </label>
        )}
      </div>
    </Dialog>
  );
}
