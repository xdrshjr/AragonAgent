/**
 * QuestionOverlay — the keyboard-driven multiple-choice wizard `ask_user`
 * renders (plan-mode §6.5).
 *
 * `OverlayFrame` MODE B (self-managed): the content is a small state machine,
 * not a list of rows, and slicing it by element would be meaningless.
 *
 * THE SINGLE HIGHEST-VALUE DECISION HERE is that the recommended option is the
 * initial highlight for every question, so `Enter Enter Enter` is a correct,
 * deliberate "use your judgement" path rather than an accident.
 *
 * `Esc` IS NOT HANDLED HERE. `App` owns it, and the bridge's `settle()` is the
 * only place a human request is ever answered. `ConfirmDialog` does the
 * opposite — both it and `App` call `resolve` — which is harmless there only by
 * accident of promise semantics, and is not a pattern to copy (R-P12).
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';
import type { Answer, NormalizedQuestion } from '../../tools/human-input.js';
import { stripPasteFrames } from '../paste-frames.js';
import { stripEnterFrames } from '../enter-frames.js';

interface QuestionOverlayProps {
  questions: NormalizedQuestion[];
  maxRows: number;
  cols: number;
  theme: Theme;
  caps: TermCapabilities;
  onSubmit: (answers: Answer[]) => void;
}

/** Which option index each question starts on: the recommended one. */
function initialCursors(questions: NormalizedQuestion[]): number[] {
  return questions.map((q) => Math.max(0, q.options.findIndex((o) => o.recommended)));
}

function initialSelections(questions: NormalizedQuestion[]): Set<number>[] {
  return questions.map((q) => {
    const recommended = q.options.findIndex((o) => o.recommended);
    return new Set<number>(recommended >= 0 ? [recommended] : [0]);
  });
}

export function QuestionOverlay({
  questions,
  maxRows,
  cols,
  theme,
  caps,
  onSubmit,
}: QuestionOverlayProps): React.ReactElement {
  const glyphs = pickGlyphs(caps);

  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState<'choosing' | 'typingOther' | 'review'>('choosing');
  const [cursors, setCursors] = useState<number[]>(() => initialCursors(questions));
  const [selections, setSelections] = useState<Set<number>[]>(() => initialSelections(questions));
  const [customs, setCustoms] = useState<string[]>(() => questions.map(() => ''));
  const [draft, setDraft] = useState('');

  const question = questions[Math.min(step, questions.length - 1)]!;
  const cursor = cursors[step] ?? 0;

  const setCursorAt = (index: number, value: number): void =>
    setCursors((prev) => prev.map((c, i) => (i === index ? value : c)));

  const setCustomAt = (index: number, value: string): void =>
    setCustoms((prev) => prev.map((c, i) => (i === index ? value : c)));

  const toggleAt = (index: number, option: number): void =>
    setSelections((prev) =>
      prev.map((set, i) => {
        if (i !== index) return set;
        const next = new Set(set);
        if (next.has(option)) next.delete(option);
        else next.add(option);
        return next;
      }),
    );

  const chooseAt = (index: number, option: number): void =>
    setSelections((prev) => prev.map((set, i) => (i === index ? new Set([option]) : set)));

  const buildAnswers = (): Answer[] =>
    questions.map((q, i) => {
      const chosen = [...(selections[i] ?? new Set<number>())].sort((a, b) => a - b);
      const labels = chosen.map((index) => q.options[index]?.label ?? '').filter((l) => l.length > 0);
      const pickedOther = chosen.some((index) => q.options[index]?.isOther);
      return {
        id: q.id,
        question: q.question,
        selected: labels,
        custom: pickedOther && (customs[i] ?? '').length > 0 ? customs[i]! : null,
      };
    });

  const advance = (): void => {
    if (step + 1 >= questions.length) setPhase('review');
    else {
      setStep(step + 1);
      setPhase('choosing');
    }
  };

  const goBack = (): void => {
    if (step === 0) return; // No-op on the first question, by design.
    setStep(step - 1);
    setPhase('choosing');
  };

  useInput((input, key) => {
    // App owns Esc for both new overlays (R-P12). Swallow it here so the
    // free-text editor below cannot eat the raw escape byte as a character.
    if (key.escape) return;

    if (phase === 'review') {
      if (key.return) {
        onSubmit(buildAnswers());
        return;
      }
      if (key.leftArrow) {
        setStep(questions.length - 1);
        setPhase('choosing');
      }
      return;
    }

    if (phase === 'typingOther') {
      if (key.return) {
        // An empty commit falls back to the recommended option rather than
        // recording a blank answer: the user pressed Enter, which everywhere
        // else in this wizard means "accept the sensible default".
        if (draft.trim().length === 0) {
          const recommended = Math.max(0, question.options.findIndex((o) => o.recommended));
          chooseAt(step, recommended);
          setCursorAt(step, recommended);
          setCustomAt(step, '');
        } else {
          setCustomAt(step, draft.trim());
        }
        setDraft('');
        setPhase('choosing');
        advance();
        return;
      }
      if (key.leftArrow) {
        setDraft('');
        setPhase('choosing');
        return;
      }
      if (key.backspace || key.delete) {
        setDraft(draft.slice(0, -1));
        return;
      }
      // `stripPasteFrames`, NOT `input` (I-12 / P0-2) -- the same broadcast
      // hazard `SettingsScreen` documents at length: a framed paste appended
      // verbatim stores NULs that render as nothing.
      // `stripEnterFrames` rides inside it for the newline frame a
      // Shift+Enter broadcasts (tui-shift-enter-copy-queue 3.5): same hazard,
      // same fix, and this order is the one that leaves no NUL in the draft.
      if (input && !key.ctrl && !key.meta && !key.tab) {
        setDraft(draft + stripPasteFrames(stripEnterFrames(input)));
      }
      return;
    }

    // phase === 'choosing'
    if (key.upArrow) {
      setCursorAt(step, (cursor - 1 + question.options.length) % question.options.length);
      return;
    }
    if (key.downArrow) {
      setCursorAt(step, (cursor + 1) % question.options.length);
      return;
    }
    if (key.leftArrow) {
      goBack();
      return;
    }
    if (input === ' ' && question.allowMultiple) {
      toggleAt(step, cursor);
      return;
    }
    if (key.return) {
      if (question.options[cursor]?.isOther) {
        chooseAt(step, cursor);
        setDraft(customs[step] ?? '');
        setPhase('typingOther');
        return;
      }
      if (!question.allowMultiple) chooseAt(step, cursor);
      else if (!(selections[step] ?? new Set()).has(cursor)) toggleAt(step, cursor);
      advance();
    }
  });

  const title = phase === 'review' ? 'Review your answers' : 'Clarify the request';
  const position = phase === 'review' ? '' : `  ${step + 1}/${questions.length}`;
  const hint =
    phase === 'typingOther'
      ? `type your answer ${glyphs.midDot} ${glyphs.enterKey} commit ${glyphs.midDot} ${glyphs.arrowLeft} back ${glyphs.midDot} esc cancel`
      : phase === 'review'
      ? `${glyphs.enterKey} submit ${glyphs.midDot} ${glyphs.arrowLeft} back ${glyphs.midDot} esc cancel`
      : `${glyphs.arrowUp}${glyphs.arrowDown} choose ${glyphs.midDot} ${glyphs.enterKey} next${
          question.allowMultiple ? ` ${glyphs.midDot} space toggle` : ''
        } ${glyphs.midDot} ${glyphs.arrowLeft} back ${glyphs.midDot} esc cancel`;

  return (
    <OverlayFrame
      title={`${title}${position}`}
      hint={hint}
      maxRows={maxRows}
      cols={cols}
      theme={theme}
      caps={caps}
    >
      {phase === 'review' ? (
        <ReviewBody questions={questions} answers={buildAnswers()} theme={theme} />
      ) : (
        <QuestionBody
          question={question}
          cursor={cursor}
          selected={selections[step] ?? new Set()}
          typing={phase === 'typingOther'}
          draft={draft}
          theme={theme}
          caps={caps}
        />
      )}
    </OverlayFrame>
  );
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

interface QuestionBodyProps {
  question: NormalizedQuestion;
  cursor: number;
  selected: Set<number>;
  typing: boolean;
  draft: string;
  theme: Theme;
  caps: TermCapabilities;
}

/**
 * ONE QUESTION PER SCREEN, not all of them at once. Three questions x four
 * options x a description line is 20+ rows against a ~15-row viewport on a
 * 24-row terminal.
 */
function QuestionBody({
  question,
  cursor,
  selected,
  typing,
  draft,
  theme,
  caps,
}: QuestionBodyProps): React.ReactElement {
  const glyphs = pickGlyphs(caps);
  const markOn = question.allowMultiple ? glyphs.boxChecked : glyphs.keyOn;
  const markOff = question.allowMultiple ? glyphs.boxEmpty : glyphs.keyOff;

  return (
    <Box flexDirection="column">
      <Text wrap="truncate" color={theme.accent} bold>
        {question.header}
      </Text>
      <Text wrap="truncate" color={theme.assistant}>
        {question.question}
      </Text>
      <Text> </Text>
      {question.options.map((option, i) => {
        const active = i === cursor;
        const on = selected.has(i);
        return (
          <Text key={`${question.id}-${i}`} wrap="truncate">
            <Text color={active ? theme.primary : theme.muted}>
              {active ? glyphs.caret : ' '}{' '}
            </Text>
            <Text color={on ? theme.primary : theme.muted}>{on ? markOn : markOff} </Text>
            <Text color={active ? theme.assistant : undefined} bold={active}>
              {option.isOther ? `${option.label}${glyphs.ellipsis}` : option.label}
            </Text>
            {option.description.length > 0 && (
              <Text color={theme.muted}>{'  '}{option.description}</Text>
            )}
            {option.recommended && (
              <Text backgroundColor={theme.chip.bg} color={theme.chip.fg}>
                {' '}
                RECOMMENDED{' '}
              </Text>
            )}
          </Text>
        );
      })}
      {typing && (
        <>
          <Text> </Text>
          <Text wrap="truncate">
            <Text color={theme.primary} bold>
              {glyphs.caret}{' '}
            </Text>
            {draft.length > 0 ? (
              <Text>{draft}</Text>
            ) : (
              <Text color={theme.muted}>type your own answer</Text>
            )}
            <Text inverse> </Text>
          </Text>
        </>
      )}
    </Box>
  );
}

/**
 * The review step exists because a wizard that fires on the last `Enter` with no
 * confirmation makes a mis-keyed answer unrecoverable.
 */
function ReviewBody({
  questions,
  answers,
  theme,
}: {
  questions: NormalizedQuestion[];
  answers: Answer[];
  theme: Theme;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      {questions.map((q, i) => {
        const answer = answers[i];
        const value = answer?.custom ?? answer?.selected.join(', ') ?? '';
        return (
          <Text key={q.id} wrap="truncate">
            <Text color={theme.accent}>{q.header.padEnd(14)}</Text>
            <Text color={theme.assistant}>{value}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
