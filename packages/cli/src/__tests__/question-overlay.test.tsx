/**
 * The question wizard's keyboard flow (plan-mode §6.5).
 *
 * `ink-testing-library` renders to a string and feeds raw bytes through
 * `stdin.write`, so these assertions are on what a user would actually see and
 * type. The escape sequences below are the ones Ink's `parse-keypress` maps to
 * arrow keys.
 */

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { QuestionOverlay } from '../ui/overlays/QuestionOverlay.js';
import { PlanReviewOverlay } from '../ui/overlays/PlanReviewOverlay.js';
import { getTheme } from '../ui/theme.js';
import type { TermCapabilities } from '../ui/capabilities.js';
import { normalizeQuestions, normalizePlan } from '../tools/human-input.js';

const CAPS = { colorLevel: 3 as const, unicode: true };
const ASCII_CAPS = { colorLevel: 0 as const, unicode: false };
const THEME = getTheme('cool', CAPS);
const ASCII_THEME = getTheme('cool', ASCII_CAPS);

const DOWN = '[B';
const LEFT = '[D';
const ENTER = '\r';
/** Written as an escape, not a raw byte: a lone ESC would be invisible here, and
 *  an editor that stripped it would leave a test that asserts nothing and still passes. */
const ESC = '\u001B';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const QUESTIONS = normalizeQuestions([
  {
    id: 'store',
    header: 'Datastore',
    question: 'Which datastore should the new service use?',
    options: [
      { label: 'Postgres', description: 'Matches the existing stack', recommended: true },
      { label: 'SQLite', description: 'Simplest for local dev' },
    ],
  },
  {
    id: 'api',
    header: 'API',
    question: 'API shape?',
    options: [{ label: 'REST', recommended: true }, { label: 'gRPC' }],
  },
]);

// `caps` is ANNOTATED rather than inferred from `CAPS`: the default's
// `colorLevel: 3 as const` narrows the parameter to the literal `3`, so passing
// `ASCII_CAPS` (`colorLevel: 0`) is a type error even though it is exactly what
// the ASCII case is for (W3).
function mount(onSubmit = vi.fn(), caps: TermCapabilities = CAPS, theme = THEME) {
  const utils = render(
    <QuestionOverlay
      questions={QUESTIONS}
      maxRows={Number.POSITIVE_INFINITY}
      cols={80}
      theme={theme}
      caps={caps}
      onSubmit={onSubmit}
    />,
  );
  return { ...utils, onSubmit };
}

describe('QuestionOverlay', () => {
  it('renders one question at a time with its position', async () => {
    // Three questions x four options x a description line is 20+ rows against a
    // ~15-row viewport on a 24-row terminal.
    const { lastFrame, unmount } = mount();
    await delay(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Datastore');
    expect(frame).toContain('Which datastore');
    expect(frame).toContain('1/2');
    expect(frame).not.toContain('API shape?');
    unmount();
  });

  it('starts on the RECOMMENDED option and marks it', async () => {
    const { lastFrame, unmount } = mount();
    await delay(20);
    expect(lastFrame() ?? '').toContain('RECOMMENDED');
    unmount();
  });

  it('AC-P6: Enter Enter Enter accepts every recommendation', async () => {
    // The single highest-value HCI decision in the feature: pressing Enter
    // through the wizard is a correct, deliberate "use your judgement" path
    // rather than an accident.
    const { stdin, onSubmit, unmount } = mount();
    await delay(20);
    stdin.write(ENTER); // question 1 -> recommended
    await delay(20);
    stdin.write(ENTER); // question 2 -> recommended, then review
    await delay(20);
    stdin.write(ENTER); // submit
    await delay(20);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toEqual([
      { id: 'store', question: 'Which datastore should the new service use?', selected: ['Postgres'], custom: null },
      { id: 'api', question: 'API shape?', selected: ['REST'], custom: null },
    ]);
    unmount();
  });

  it('shows a review step before submitting', async () => {
    // A wizard that fires on the last Enter with no confirmation makes a
    // mis-keyed answer unrecoverable.
    const { stdin, lastFrame, onSubmit, unmount } = mount();
    await delay(20);
    stdin.write(ENTER);
    await delay(20);
    stdin.write(ENTER);
    await delay(20);
    expect(lastFrame() ?? '').toContain('Review your answers');
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it('arrow keys move the cursor and Enter takes the highlighted option', async () => {
    const { stdin, onSubmit, unmount } = mount();
    await delay(20);
    stdin.write(DOWN);
    await delay(20);
    stdin.write(ENTER);
    await delay(20);
    stdin.write(ENTER);
    await delay(20);
    stdin.write(ENTER);
    await delay(20);
    expect(onSubmit.mock.calls[0]![0][0].selected).toEqual(['SQLite']);
    unmount();
  });

  it('AC-P7: Other opens the inline editor and lands in `custom`', async () => {
    const { stdin, lastFrame, onSubmit, unmount } = mount();
    await delay(20);
    stdin.write(DOWN); // SQLite
    await delay(20);
    stdin.write(DOWN); // Other
    await delay(20);
    stdin.write(ENTER);
    await delay(20);
    expect(lastFrame() ?? '').toContain('type your own answer');

    stdin.write('DynamoDB');
    await delay(20);
    stdin.write(ENTER);
    await delay(20);
    stdin.write(ENTER); // accept question 2's recommendation
    await delay(20);
    stdin.write(ENTER); // submit
    await delay(20);

    const answers = onSubmit.mock.calls[0]![0];
    expect(answers[0].selected).toEqual(['Other']);
    expect(answers[0].custom).toBe('DynamoDB');
    unmount();
  });

  it('an empty Other falls back to the recommended option', async () => {
    const { stdin, onSubmit, unmount } = mount();
    await delay(20);
    stdin.write(DOWN);
    await delay(20);
    stdin.write(DOWN);
    await delay(20);
    stdin.write(ENTER); // enter the editor
    await delay(20);
    stdin.write(ENTER); // commit nothing
    await delay(20);
    stdin.write(ENTER);
    await delay(20);
    stdin.write(ENTER);
    await delay(20);

    const answers = onSubmit.mock.calls[0]![0];
    expect(answers[0].selected).toEqual(['Postgres']);
    expect(answers[0].custom).toBeNull();
    unmount();
  });

  it('Left goes back a question and is a no-op on the first', async () => {
    const { stdin, lastFrame, unmount } = mount();
    await delay(20);
    stdin.write(LEFT);
    await delay(20);
    expect(lastFrame() ?? '').toContain('1/2');

    stdin.write(ENTER);
    await delay(20);
    expect(lastFrame() ?? '').toContain('2/2');
    stdin.write(LEFT);
    await delay(20);
    expect(lastFrame() ?? '').toContain('1/2');
    unmount();
  });

  it('AC-P17: emits no non-ASCII byte when the terminal cannot render Unicode', async () => {
    const { lastFrame, unmount } = mount(vi.fn(), ASCII_CAPS, ASCII_THEME);
    await delay(20);
    // eslint-disable-next-line no-control-regex
    const plain = (lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).not.toMatch(/[^\x00-\x7f]/);
    unmount();
  });
});

describe('PlanReviewOverlay', () => {
  const PLAN = normalizePlan({
    title: 'Add SSO via OIDC',
    summary: Array.from({ length: 80 }, () => 'summary').join(' '),
    steps: [
      { title: 'Add the oidc client dependency', detail: 'And the config keys.' },
      { title: 'Implement src/auth/oidc.ts', detail: 'Token exchange + JWKS caching.' },
    ],
    filesTouched: ['src/auth/oidc.ts'],
    risks: ['Token refresh races with the existing timer'],
  })!;

  function mountPlan(onVerdict = vi.fn()) {
    const utils = render(
      <PlanReviewOverlay
        plan={PLAN}
        maxRows={Number.POSITIVE_INFINITY}
        cols={60}
        scrollOffset={0}
        onScrollClamp={() => {}}
        theme={THEME}
        caps={CAPS}
        onVerdict={onVerdict}
      />,
    );
    return { ...utils, onVerdict };
  }

  it('P1-3: wraps the prose instead of truncating it to a single line', async () => {
    const { lastFrame, unmount } = mountPlan();
    await delay(20);
    const frame = lastFrame() ?? '';
    // The summary is 80 words at 60 columns; if it rendered as one <Text> the
    // frame would hold exactly one line of it and the position indicator would
    // be lying.
    const summaryLines = frame.split('\n').filter((l) => l.includes('summary'));
    expect(summaryLines.length).toBeGreaterThan(5);
    unmount();
  });

  it('renders the title, the numbered steps and the sections', async () => {
    const { lastFrame, unmount } = mountPlan();
    await delay(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Add SSO via OIDC');
    expect(frame).toContain('1  Add the oidc client dependency');
    expect(frame).toContain('Risks');
    expect(frame).toContain('a approve');
    unmount();
  });

  it('`a` approves and `r` opens the feedback editor', async () => {
    const { stdin, lastFrame, onVerdict, unmount } = mountPlan();
    await delay(20);
    stdin.write('r');
    await delay(20);
    expect(lastFrame() ?? '').toContain('What should change?');

    stdin.write('use the session store');
    await delay(20);
    stdin.write(ENTER);
    await delay(20);
    expect(onVerdict).toHaveBeenCalledWith({
      decision: 'revise',
      feedback: 'use the session store',
    });
    unmount();

    const second = mountPlan();
    await delay(20);
    second.stdin.write('a');
    await delay(20);
    expect(second.onVerdict).toHaveBeenCalledWith({ decision: 'approved', feedback: '' });
    second.unmount();
  });

  it('R2-P1-2: `<-` returns from the feedback field to the card, and Esc is left alone', async () => {
    // Without this the field is a one-way door: it consumes printable input and
    // Backspace, and the only other exit is `App`'s Esc, which throws the whole
    // review away. The back key must NOT be Esc — a second Esc consumer here is
    // the double-resolve pattern R-P12 rules out — so this also asserts that
    // pressing Esc changes nothing inside the overlay.
    const { stdin, lastFrame, onVerdict, unmount } = mountPlan();
    await delay(20);
    stdin.write('r');
    await delay(20);
    stdin.write('half a thought');
    await delay(20);
    expect(lastFrame() ?? '').toContain('What should change?');
    expect(lastFrame() ?? '').toContain('← back');

    stdin.write(ESC); // swallowed here; `App` is the one that dismisses
    await delay(20);
    expect(lastFrame() ?? '').toContain('What should change?');

    stdin.write(LEFT);
    await delay(20);
    const back = lastFrame() ?? '';
    expect(back).toContain('Review plan');
    expect(back).toContain('a approve');
    expect(back).not.toContain('half a thought');
    expect(onVerdict).not.toHaveBeenCalled();
    unmount();
  });
});
