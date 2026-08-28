/**
 * `ask_user` / `submit_plan` and the two normalizers (plan-mode §4.1 / §4.2 /
 * §5.1).
 *
 * The normalizer matrices deliberately feed inputs that violate every documented
 * bound. That is only meaningful because §4.1's schema stopped declaring
 * `minItems` / `maxItems` / `maxLength` (P0-4): with the bounds in the schema,
 * `ajv` rejected these calls before any repair ran, and half the rules below
 * were dead code — but only on machines where the OPTIONAL `ajv` dependency had
 * installed, which is the worse half of the problem.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ToolExecutionContext, ToolResult } from '@aragon-agent/core';
import {
  DENY_ALL_HUMAN_INPUT,
  normalizePlan,
  normalizeQuestions,
  type HumanInputGate,
  type HumanRequest,
  type HumanResponse,
} from '../tools/human-input.js';
import { createPlanTools, type AskRoundTicket } from '../tools/plan-tools.js';

const ctx: ToolExecutionContext = {};

function text(result: ToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

function jsonTail(result: ToolResult): Record<string, unknown> {
  const body = text(result);
  return JSON.parse(body.slice(body.indexOf('{'))) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeGateOptions {
  respond?: (req: HumanRequest) => HumanResponse | null;
  /** Never resolve; used for the abort tests. */
  hang?: boolean;
}

function fakeGate(opts: FakeGateOptions = {}): HumanInputGate & { seen: HumanRequest[] } {
  const seen: HumanRequest[] = [];
  return {
    seen,
    canPrompt: () => true,
    request(req, signal) {
      seen.push(req);
      if (!opts.hang) return Promise.resolve(opts.respond ? opts.respond(req) : null);
      return new Promise<HumanResponse | null>((resolve) => {
        signal?.addEventListener('abort', () => resolve(null), { once: true });
      });
    },
  };
}

function budget(max = 4): { take: () => AskRoundTicket; used: () => number } {
  let used = 0;
  return {
    used: () => used,
    take: () => {
      if (used >= max) return { ok: false, used, remaining: 0, max };
      used += 1;
      return { ok: true, used, remaining: max - used, max };
    },
  };
}

function build(gate: HumanInputGate, rounds = budget(), onPlanApproved = vi.fn()) {
  const tools = createPlanTools({
    gate,
    takeAskRound: rounds.take,
    withHumanWait: (fn) => fn(),
    onPlanApproved,
  });
  return {
    askUser: tools.find((t) => t.name === 'ask_user'),
    submitPlan: tools.find((t) => t.name === 'submit_plan'),
    onPlanApproved,
    rounds,
  };
}

const ONE_QUESTION = {
  questions: [
    {
      id: 'store',
      header: 'Datastore',
      question: 'Which datastore?',
      options: [
        { label: 'Postgres', description: 'Matches the stack', recommended: true },
        { label: 'SQLite' },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('createPlanTools registration (P0-3)', () => {
  it('returns [] for a gate that can NEVER reach a human', () => {
    const tools = createPlanTools({
      gate: DENY_ALL_HUMAN_INPUT,
      takeAskRound: () => ({ ok: true, used: 1, remaining: 3, max: 4 }),
      withHumanWait: (fn) => fn(),
      onPlanApproved: () => {},
    });
    expect(tools).toEqual([]);
  });

  it('registers both tools for a gate whose canPrompt() is CURRENTLY false', () => {
    // The exact P0-3 failure: `makeController()` builds the tool array while the
    // bridge handler is still null, because the App attaches it in a later
    // effect. Keying registration on the live probe would ship plan mode with no
    // tools at all, in every interactive session, with nothing reporting it.
    const notYetMounted: HumanInputGate = {
      canPrompt: () => false,
      request: async () => null,
    };
    const names = createPlanTools({
      gate: notYetMounted,
      takeAskRound: () => ({ ok: true, used: 1, remaining: 3, max: 4 }),
      withHumanWait: (fn) => fn(),
      onPlanApproved: () => {},
    }).map((t) => t.name);
    expect(names).toEqual(['ask_user', 'submit_plan']);
  });
});

// ---------------------------------------------------------------------------
// ask_user
// ---------------------------------------------------------------------------

describe('ask_user', () => {
  it('renders the wizard and reports the chosen labels', async () => {
    const gate = fakeGate({
      respond: () => ({
        kind: 'answers',
        answers: [{ id: 'store', question: 'Which datastore?', selected: ['Postgres'], custom: null }],
        cancelled: false,
      }),
    });
    const { askUser } = build(gate);
    const result = await askUser!.execute('1', ONE_QUESTION, ctx);

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('User answered 1 of 1 questions.');
    const parsed = jsonTail(result);
    expect(parsed.cancelled).toBe(false);
    expect(parsed.roundsUsed).toBe(1);
    expect(parsed.roundsRemaining).toBe(3);
  });

  it('AC-P8: a cancelled wizard is a NON-error result with guidance', async () => {
    // A cancellation rendered as a tool failure invites a retry loop; the model
    // needs to be told what to do instead, not that something broke.
    const gate = fakeGate({ respond: () => null });
    const { askUser } = build(gate);
    const result = await askUser!.execute('1', ONE_QUESTION, ctx);

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('User dismissed the questions.');
    expect(text(result)).toContain('best assumptions');
    expect(jsonTail(result).cancelled).toBe(true);
  });

  it('AC-P9: refuses past the round cap and says what to do instead', async () => {
    const gate = fakeGate({ respond: () => ({ kind: 'answers', answers: [], cancelled: false }) });
    const rounds = budget(2);
    const { askUser } = build(gate, rounds);

    await askUser!.execute('1', ONE_QUESTION, ctx);
    await askUser!.execute('2', ONE_QUESTION, ctx);
    const refused = await askUser!.execute('3', ONE_QUESTION, ctx);

    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('already asked 2 rounds');
    expect(text(refused)).toContain('best assumptions');
    // The refused call must not have opened an overlay.
    expect(gate.seen).toHaveLength(2);
  });

  it('refuses headlessly without waiting on anything', async () => {
    const headless: HumanInputGate = { canPrompt: () => false, request: async () => null };
    const { askUser } = build(headless);
    const result = await askUser!.execute('1', ONE_QUESTION, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No interactive user is attached');
  });

  it('does not spend a round on a call with no usable questions', async () => {
    const gate = fakeGate();
    const rounds = budget();
    const { askUser } = build(gate, rounds);
    const result = await askUser!.execute('1', { questions: [{ id: 'x' }] }, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No usable questions');
    expect(rounds.used()).toBe(0);
  });

  it('I-P10: aborting ctx.signal resolves the wait as a cancellation', async () => {
    // `ToolExecutor` expresses BOTH its own timeout and an external abort by
    // aborting this signal and then continuing to await the tool. Without this
    // path the plan tools have no ceiling at all, because §3.6 also pauses the
    // idle watchdog.
    const gate = fakeGate({ hang: true });
    const { askUser } = build(gate);
    const controller = new AbortController();

    const pending = askUser!.execute('1', ONE_QUESTION, { signal: controller.signal });
    controller.abort();
    const result = await pending;

    expect(result.isError).toBeFalsy();
    expect(jsonTail(result).cancelled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// submit_plan
// ---------------------------------------------------------------------------

const PLAN = {
  title: 'Add SSO via OIDC',
  summary: 'Introduce an oidc provider module.',
  steps: [{ title: 'Add the client dependency', detail: 'And the config keys.' }],
};

describe('submit_plan', () => {
  it('AC-P10: approval flips the mode and says so', async () => {
    const gate = fakeGate({
      respond: () => ({ kind: 'planDecision', decision: 'approved', feedback: '' }),
    });
    const { submitPlan, onPlanApproved } = build(gate);
    const result = await submitPlan!.execute('1', PLAN, ctx);

    expect(result.isError).toBeFalsy();
    expect(onPlanApproved).toHaveBeenCalledTimes(1);
    expect(text(result)).toContain('Plan approved');
    expect(text(result)).toContain('Build mode');
  });

  it('AC-P11: revise returns the feedback verbatim and does NOT flip the mode', async () => {
    const gate = fakeGate({
      respond: () => ({ kind: 'planDecision', decision: 'revise', feedback: 'use the session store' }),
    });
    const { submitPlan, onPlanApproved } = build(gate);
    const result = await submitPlan!.execute('1', PLAN, ctx);

    expect(text(result)).toContain('use the session store');
    expect(text(result)).toContain('call submit_plan again');
    expect(onPlanApproved).not.toHaveBeenCalled();
  });

  it('treats dismissal and abort as the same non-error situation', async () => {
    const gate = fakeGate({ respond: () => null });
    const { submitPlan, onPlanApproved } = build(gate);
    const result = await submitPlan!.execute('1', PLAN, ctx);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('dismissed the plan review');
    expect(onPlanApproved).not.toHaveBeenCalled();
  });

  it('AC-P15: headless emits guidance, NOT an error', async () => {
    // `aragon -p --plan "..."` is a genuinely useful combination: the read-only
    // gate still applies, so it means "tell me how you would do this, and do not
    // touch my repository".
    const headless: HumanInputGate = { canPrompt: () => false, request: async () => null };
    const { submitPlan } = build(headless);
    const result = await submitPlan!.execute('1', PLAN, ctx);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('markdown');
  });

  it('rejects only a plan with no usable step', async () => {
    const gate = fakeGate();
    const { submitPlan } = build(gate);
    const result = await submitPlan!.execute('1', { title: 't', summary: 's', steps: [] }, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('at least one step');
  });
});

// ---------------------------------------------------------------------------
// normalizeQuestions
// ---------------------------------------------------------------------------

describe('normalizeQuestions repair matrix (I-P7)', () => {
  const q = (over: Record<string, unknown> = {}) => ({
    id: 'q',
    header: 'H',
    question: 'Which?',
    options: [{ label: 'A' }, { label: 'B' }],
    ...over,
  });

  it('AC-P23: repairs 7 questions, one with 6 options and a 40-char header', () => {
    const questions = Array.from({ length: 7 }, (_, i) => q({ id: `q${i}` }));
    questions[0] = q({
      id: 'q0',
      header: 'x'.repeat(40),
      options: Array.from({ length: 6 }, (_, i) => ({ label: `opt${i}` })),
    });

    const out = normalizeQuestions(questions);
    expect(out).toHaveLength(5);
    expect(out[0]!.header).toHaveLength(12);
    // 4 given + the synthetic Other.
    expect(out[0]!.options).toHaveLength(5);
    expect(out[0]!.options.at(-1)!.isOther).toBe(true);
  });

  it('marks the first option recommended when none is', () => {
    const out = normalizeQuestions([q()]);
    expect(out[0]!.options.filter((o) => o.recommended)).toHaveLength(1);
    expect(out[0]!.options[0]!.recommended).toBe(true);
  });

  it('keeps the FIRST recommended and clears the rest', () => {
    const out = normalizeQuestions([
      q({ options: [{ label: 'A' }, { label: 'B', recommended: true }, { label: 'C', recommended: true }] }),
    ]);
    const flags = out[0]!.options.map((o) => o.recommended);
    expect(flags.filter(Boolean)).toHaveLength(1);
    expect(out[0]!.options[1]!.recommended).toBe(true);
  });

  it('deduplicates option labels case-insensitively', () => {
    const out = normalizeQuestions([q({ options: [{ label: 'Yes' }, { label: 'yes' }, { label: 'No' }] })]);
    expect(out[0]!.options.map((o) => o.label)).toEqual(['Yes', 'No', 'Other']);
  });

  it('drops a question left with fewer than two distinct options', () => {
    expect(normalizeQuestions([q({ options: [{ label: 'Yes' }, { label: 'YES' }] })])).toEqual([]);
    expect(normalizeQuestions([q({ options: [{ label: 'only' }] })])).toEqual([]);
  });

  it('does not add a second Other when the model already supplied one', () => {
    const out = normalizeQuestions([q({ options: [{ label: 'A' }, { label: 'Other (specify)' }] })]);
    expect(out[0]!.options.filter((o) => o.isOther)).toHaveLength(1);
    expect(out[0]!.options).toHaveLength(2);
  });

  it('never returns 0 or >1 recommended options, for any of the above', () => {
    const inputs: unknown[] = [
      [q()],
      [q({ options: [{ label: 'A', recommended: true }, { label: 'B', recommended: true }] })],
      [q({ options: [{ label: 'A' }, { label: 'B' }, { label: 'Other' }] })],
    ];
    for (const input of inputs) {
      for (const question of normalizeQuestions(input)) {
        expect(question.options.filter((o) => o.recommended)).toHaveLength(1);
        expect(question.options.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('survives structurally wrong input without throwing', () => {
    expect(normalizeQuestions(undefined)).toEqual([]);
    expect(normalizeQuestions('nope')).toEqual([]);
    expect(normalizeQuestions([null, 7, { options: 'x' }])).toEqual([]);
  });

  it('substitutes an id and a header when the model omits them', () => {
    const out = normalizeQuestions([{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }]);
    expect(out[0]!.id).toBe('q1');
    expect(out[0]!.header).toBe('Q1');
  });
});

// ---------------------------------------------------------------------------
// normalizePlan
// ---------------------------------------------------------------------------

describe('normalizePlan repair matrix (P2-2)', () => {
  it('clamps the scalars, preferring a word boundary', () => {
    const plan = normalizePlan({
      title: `${'word '.repeat(40)}end`,
      summary: 'x'.repeat(900),
      steps: [{ title: 'ok', detail: 'y'.repeat(900) }],
    })!;
    expect(plan.title.length).toBeLessThanOrEqual(80);
    // The word-boundary rule: a title made of words must not end mid-word.
    expect(plan.title.endsWith('word')).toBe(true);
    expect(plan.summary).toHaveLength(600);
    expect(plan.steps[0]!.detail).toHaveLength(400);
  });

  it('keeps the first 20 steps and drops blank-titled ones', () => {
    const steps = Array.from({ length: 25 }, (_, i) => ({ title: `step ${i}` }));
    steps.splice(3, 0, { title: '   ' });
    const plan = normalizePlan({ title: 't', summary: 's', steps })!;
    expect(plan.steps).toHaveLength(20);
    expect(plan.steps.every((s) => s.title.trim().length > 0)).toBe(true);
  });

  it('caps the lists and dedupes filesTouched EXACTLY, not case-insensitively', () => {
    // POSIX paths are case-sensitive; two casings are two files, and silently
    // merging them would hide one from the reviewer.
    const plan = normalizePlan({
      title: 't',
      summary: 's',
      steps: [{ title: 'a' }],
      filesTouched: ['a.ts', 'a.ts', 'A.ts', ...Array.from({ length: 40 }, (_, i) => `f${i}.ts`)],
      risks: Array.from({ length: 15 }, (_, i) => `r${i}`),
      openQuestions: Array.from({ length: 15 }, (_, i) => `q${i}`),
    })!;
    expect(plan.filesTouched).toHaveLength(30);
    expect(plan.filesTouched.slice(0, 2)).toEqual(['a.ts', 'A.ts']);
    expect(plan.risks).toHaveLength(10);
    expect(plan.openQuestions).toHaveLength(10);
  });

  it('returns null only when no step survives', () => {
    expect(normalizePlan({ title: 't', summary: 's', steps: [{ title: '  ' }] })).toBeNull();
    expect(normalizePlan(undefined)).toBeNull();
    expect(normalizePlan({ title: 't', summary: 's', steps: [{ title: 'a' }] })).not.toBeNull();
  });

  it('substitutes a title rather than throwing one away', () => {
    const plan = normalizePlan({ steps: [{ title: 'a' }] })!;
    expect(plan.title).toBe('Untitled plan');
    expect(plan.summary).toBe('');
  });
});
