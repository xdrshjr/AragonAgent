/**
 * PlanReviewOverlay — the reviewable card `submit_plan` renders (plan-mode §6.6).
 *
 * `OverlayFrame` MODE A (`rows`), because a 20-step plan must scroll and mode A
 * is the only mode with a position indicator.
 *
 * MODE A SLICES BY ELEMENT, SO THE PROSE IS PRE-WRAPPED. `sliceWindow` counts
 * elements, not lines, and each element must be exactly one row. The summary
 * runs to 600 characters and a step detail to 400 — handing either over as a
 * single `<Text>` would render the whole paragraph as one truncated line and
 * make the frame's `1-14/22` a false statement. `wrapToRows` is what keeps the
 * count honest.
 *
 * ACTIONS LIVE IN THE FRAME HINT, NOT IN `rows`. Mode A slices `rows`; an action
 * row placed there would scroll off exactly when a long plan needs it most.
 * Single-key actions also avoid a second selection cursor competing with the
 * scroll cursor.
 *
 * `Esc` IS NOT HANDLED HERE, and neither is any resolution of the pending
 * request: `App` owns Esc, and the bridge's `settle()` is the only place a human
 * request is answered (R-P12). That holds in the revise sub-state too, which is
 * why the way back from the feedback field is `<-` rather than `Esc` (R2-P1-2).
 */

import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';
import { wrapToRows } from '../layout/wrap-rows.js';
import type { NormalizedPlan } from '../../tools/human-input.js';
import { stripPasteFrames } from '../paste-frames.js';

export type PlanVerdict = { decision: 'approved' | 'revise'; feedback: string };

interface PlanReviewOverlayProps {
  plan: NormalizedPlan;
  maxRows: number;
  cols: number;
  scrollOffset: number;
  onScrollClamp: (offset: number) => void;
  theme: Theme;
  caps: TermCapabilities;
  onVerdict: (verdict: PlanVerdict) => void;
}

/** The frame's border plus its one-column padding on each side. */
const FRAME_CHROME_COLS = 4;

export function PlanReviewOverlay({
  plan,
  maxRows,
  cols,
  scrollOffset,
  onScrollClamp,
  theme,
  caps,
  onVerdict,
}: PlanReviewOverlayProps): React.ReactElement {
  const glyphs = pickGlyphs(caps);
  const [feedback, setFeedback] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape) return; // App owns dismiss.

    if (feedback !== null) {
      if (key.return) {
        onVerdict({ decision: 'revise', feedback: feedback.trim() });
        return;
      }
      // THE WAY BACK TO THE CARD, and the reason it is `<-` and not `Esc`:
      // `App` owns Esc here and settles the pending request with it, so a second
      // Esc consumer in this overlay would be the `ConfirmDialog` double-resolve
      // pattern R-P12 exists to keep out. `QuestionOverlay` already spends `<-`
      // on "back", so this costs no key ownership. Without it the field is a
      // one-way door — it consumes printable input and Backspace, and the only
      // other exit throws the whole review away (R2-P1-2).
      if (key.leftArrow) {
        setFeedback(null);
        return;
      }
      if (key.backspace || key.delete) {
        setFeedback(feedback.slice(0, -1));
        return;
      }
      // `stripPasteFrames`, NOT `input` (I-12 / P0-2). This is the THIRD consumer
      // that appends `input` to a string; the design's table listed it as
      // "key-driven only, inert", which was true of the version that had no
      // free-text field. Revision feedback is exactly the kind of thing a user
      // pastes — a failing test, a stack trace — and a framed paste appended
      // verbatim would put NULs into text the model then reads.
      if (input && !key.ctrl && !key.meta && !key.tab) {
        setFeedback(feedback + stripPasteFrames(input));
      }
      return;
    }

    if (input === 'a' || input === 'A') onVerdict({ decision: 'approved', feedback: '' });
    else if (input === 'r' || input === 'R') setFeedback('');
  });

  const width = Math.max(20, cols - FRAME_CHROME_COLS);
  const rows = buildPlanRows(plan, width, theme, glyphs.bullet);

  if (feedback !== null) {
    // `esc dismiss`, NOT "esc back to the plan": `App` owns Esc for this overlay
    // (R-P12) and settles the pending request with `null`, so Esc throws the
    // whole review away from either sub-state. `<-` is the route back to the
    // card, which is why it is named here too.
    const feedbackHint = `${glyphs.enterKey} send ${glyphs.midDot} ${glyphs.arrowLeft} back ${glyphs.midDot} esc dismiss`;
    return (
      <OverlayFrame
        title="What should change?"
        hint={feedbackHint}
        maxRows={maxRows}
        cols={cols}
        theme={theme}
        caps={caps}
      >
        <Text wrap="truncate" color={theme.muted}>
          The agent revises the plan and submits it again.
        </Text>
        <Text wrap="truncate">
          <Text color={theme.primary} bold>
            {glyphs.caret}{' '}
          </Text>
          {feedback.length > 0 ? (
            <Text>{feedback}</Text>
          ) : (
            <Text color={theme.muted}>e.g. use the existing session store instead</Text>
          )}
          <Text inverse> </Text>
        </Text>
      </OverlayFrame>
    );
  }

  return (
    <OverlayFrame
      title="Review plan"
      hint={`a approve ${glyphs.midDot} r revise ${glyphs.midDot} esc dismiss ${glyphs.midDot} ${glyphs.arrowUp}${glyphs.arrowDown} scroll`}
      maxRows={maxRows}
      cols={cols}
      rows={rows}
      scrollOffset={scrollOffset}
      onScrollClamp={onScrollClamp}
      theme={theme}
      caps={caps}
    />
  );
}

/**
 * Flatten the plan into one-row elements.
 *
 * Exported for `plan-mode.test.ts`, which asserts that a 600-character summary
 * really does become many rows rather than one truncated line (P1-3).
 */
export function buildPlanRows(
  plan: NormalizedPlan,
  width: number,
  theme: Theme,
  bullet: string,
): React.ReactElement[] {
  const rows: React.ReactElement[] = [];
  let key = 0;
  const push = (node: React.ReactNode, color?: string, bold?: boolean): void => {
    rows.push(
      <Text key={`p${key++}`} wrap="truncate" color={color} bold={bold}>
        {node}
      </Text>,
    );
  };

  push(plan.title, theme.assistant, true);
  for (const line of wrapToRows(plan.summary, width)) push(line || ' ', theme.muted);

  push(' ');
  push('Steps', theme.accent, true);
  plan.steps.forEach((step, i) => {
    const number = String(i + 1).padStart(2, ' ');
    push(`${number}  ${step.title}`);
    for (const line of wrapToRows(step.detail, Math.max(10, width - 4))) {
      push(`    ${line}`, theme.muted);
    }
  });

  const section = (label: string, items: string[]): void => {
    if (items.length === 0) return;
    push(' ');
    push(label, theme.accent, true);
    for (const item of items) {
      for (const line of wrapToRows(`${bullet} ${item}`, width)) push(line, theme.muted);
    }
  };

  section('Files', plan.filesTouched);
  section('Risks', plan.risks);
  section('Open questions', plan.openQuestions);

  return rows;
}
