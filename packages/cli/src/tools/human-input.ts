/**
 * The human-input channel (plan-mode §3.5 / §5.1) — types, the fail-closed
 * default gate, and the two pure normalizers that repair whatever the model
 * actually sent.
 *
 * Everything here is pure except the type declarations: no Ink, no React, no
 * `node:*`. `tools/` is inside the glyph scanner's scope, so every literal is
 * ASCII.
 *
 * WHY THE NORMALIZERS ARE THE ONLY AUTHORITY ON THE LIMITS (P0-4). The
 * model-facing schemas in `plan-tools.ts` declare SHAPE only — `type`,
 * `required`, `default` — and put every bound in the `description`. They used to
 * carry `minItems` / `maxItems` / `maxLength`, and that had two failure modes at
 * once: `ToolExecutor` rejected a six-question call outright with `Invalid
 * parameters: ...` before any repair could run, wasting a full research turn on
 * a cosmetic defect; and `ajv` is an OPTIONAL dependency of core, so without it
 * the fallback validator checks `required` plus primitive types only and the
 * same call sailed through. One design, two behaviours, selected by whether an
 * optional install step succeeded. Bounds live here instead, where they are
 * deterministic and unit-tested.
 */

import { OTHER_OPTION_LABEL } from '../agent/agent-mode.js';

// ---------------------------------------------------------------------------
// Normalized shapes (post-repair; the UI and the tool result see only these)
// ---------------------------------------------------------------------------

export interface NormalizedOption {
  label: string;
  /** `''` when the model supplied none. */
  description: string;
  /** Exactly one per question is true after repair. */
  recommended: boolean;
  /** The synthetic free-text option. */
  isOther: boolean;
}

export interface NormalizedQuestion {
  id: string;
  /** <= 12 chars, truncated. Rendered as a chip above the question. */
  header: string;
  question: string;
  /** 3..5 entries: the 2..4 the model gave, plus the synthetic `Other`. */
  options: NormalizedOption[];
  allowMultiple: boolean;
}

export interface Answer {
  id: string;
  question: string;
  /** Option labels. Length 1 unless `allowMultiple`. */
  selected: string[];
  /** Set only when `Other` was chosen. */
  custom: string | null;
}

export interface NormalizedPlan {
  title: string;
  summary: string;
  steps: { title: string; detail: string }[];
  filesTouched: string[];
  risks: string[];
  openQuestions: string[];
}

// ---------------------------------------------------------------------------
// The gate / bridge contract
// ---------------------------------------------------------------------------

export type HumanRequest =
  | { kind: 'questions'; questions: NormalizedQuestion[] }
  | { kind: 'plan'; plan: NormalizedPlan };

export type HumanResponse =
  | { kind: 'answers'; answers: Answer[]; cancelled: boolean }
  | {
      kind: 'planDecision';
      decision: 'approved' | 'revise' | 'dismissed';
      feedback: string;
    };

export interface HumanInputGate {
  /**
   * STATIC property of the channel: `true` only for a gate that can never
   * acquire a human at all. Set on `DENY_ALL_HUMAN_INPUT` and nowhere else.
   *
   * This — not `canPrompt()` — is what `createPlanTools()` keys registration
   * off. `canPrompt()` is a LIVE probe and is legitimately `false` for the whole
   * window between `makeController()` and the App's first effect, because the
   * App attaches the bridge handler later. A registration decision taken from it
   * would be "no plan tools", forever, in every interactive session, with no
   * error anywhere. The two predicates answer different questions and must not
   * be merged.
   */
  readonly neverPrompts?: boolean;
  /** True only while a TUI is mounted and able to render an overlay. */
  canPrompt(): boolean;
  /**
   * Resolves with `null` when cancelled / unmounted / aborted. NEVER rejects.
   *
   * `signal` is the tool's `ctx.signal` and is REQUIRED in practice. It is the
   * only ceiling the wait has: `ToolExecutor`'s timeout is cooperative — it
   * aborts the context signal and keeps awaiting the tool's promise, with no
   * `Promise.race` anywhere — and the idle watchdog is deliberately paused for
   * the duration of the wait. Passing `undefined` therefore gives a wait with no
   * ceiling of any kind, and the process wedges behind an overlay nobody is
   * going to answer.
   */
  request(req: HumanRequest, signal?: AbortSignal): Promise<HumanResponse | null>;
}

export interface HumanInputBridge {
  handler:
    | ((req: HumanRequest, signal?: AbortSignal) => Promise<HumanResponse | null>)
    | null;
  /**
   * Resolve every outstanding request with `null`.
   *
   * Called on App unmount AND when a run ends. `ConfirmBridge` nulls its handler
   * on unmount but leaves any in-flight promise dangling forever; with a
   * three-second `y/N` that never mattered, but a question wizard the user
   * abandons with `Ctrl+C` twice would hang the tool until its ceiling.
   */
  cancelPending(): void;
}

/**
 * Fails CLOSED. The headless default — forgetting to pass a gate must refuse,
 * never hang and never assume yes.
 */
export const DENY_ALL_HUMAN_INPUT: HumanInputGate = {
  neverPrompts: true,
  canPrompt: () => false,
  request: async () => null,
};

// ---------------------------------------------------------------------------
// Limits (the single authority; see the module header for why not the schema)
// ---------------------------------------------------------------------------

export const QUESTION_LIMITS = {
  maxQuestions: 5,
  minOptions: 2,
  maxOptions: 4,
  headerChars: 12,
  questionChars: 300,
  labelChars: 60,
  optionDescriptionChars: 120,
} as const;

export const PLAN_LIMITS = {
  titleChars: 80,
  summaryChars: 600,
  maxSteps: 20,
  stepTitleChars: 100,
  stepDetailChars: 400,
  maxFiles: 30,
  maxRisks: 10,
  maxOpenQuestions: 10,
} as const;

/** How far back a truncation will look for a space before cutting hard. */
const WORD_BOUNDARY_WINDOW = 12;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Trim to `max` characters, preferring a word boundary within the last
 * `WORD_BOUNDARY_WINDOW` characters. Cutting a sentence mid-word reads as
 * corruption; cutting it at a space reads as a summary.
 */
export function clampText(raw: unknown, max: number): string {
  const text = asString(raw).trim();
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const space = head.lastIndexOf(' ');
  if (space >= max - WORD_BOUNDARY_WINDOW && space > 0) return head.slice(0, space).trimEnd();
  return head.trimEnd();
}

/**
 * DROP FIRST, CAP SECOND, and it matters.
 *
 * Capping the raw array first would let blank or duplicate entries consume slots
 * the model meant for real content: a list of 30 paths with two repeats would
 * come back with 28 real ones and no way to tell that anything was lost.
 */
function nonEmptyStrings(raw: unknown, max: number, dedupe = false): string[] {
  const cleaned = asArray(raw)
    .map((v) => asString(v).trim())
    .filter((s) => s.length > 0);
  return (dedupe ? [...new Set(cleaned)] : cleaned).slice(0, max);
}

// ---------------------------------------------------------------------------
// normalizeQuestions
// ---------------------------------------------------------------------------

/**
 * Repair whatever the model sent into something renderable.
 *
 * Returns `[]` when nothing survives, which the tool turns into the one hard
 * failure this path has. Every rule below is reachable precisely BECAUSE the
 * schema stopped declaring the bounds (P0-4); with `minItems` / `maxItems` in
 * the schema, `ajv` rejected the call first and rules 1 and 4 were dead code.
 */
export function normalizeQuestions(raw: unknown): NormalizedQuestion[] {
  const out: NormalizedQuestion[] = [];

  // Rule 1a: keep the first N questions.
  for (const item of asArray(raw).slice(0, QUESTION_LIMITS.maxQuestions)) {
    const question = normalizeOneQuestion(asRecord(item), out.length);
    if (question) out.push(question);
  }
  return out;
}

function normalizeOneQuestion(
  src: Record<string, unknown>,
  index: number,
): NormalizedQuestion | null {
  const text = clampText(src.question, QUESTION_LIMITS.questionChars);
  if (text.length === 0) return null;

  // Rule 1b + 1c: at least 2 options, at most 4.
  const rawOptions = asArray(src.options).slice(0, QUESTION_LIMITS.maxOptions);
  const options: NormalizedOption[] = [];
  const seen = new Set<string>();

  for (const rawOption of rawOptions) {
    const record = asRecord(rawOption);
    const label = clampText(record.label, QUESTION_LIMITS.labelChars);
    if (label.length === 0) continue;
    // Rule 4: deduplicate labels case-insensitively. Two options the user cannot
    // tell apart is worse than one option fewer.
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({
      label,
      description: clampText(record.description, QUESTION_LIMITS.optionDescriptionChars),
      recommended: record.recommended === true,
      isOther: false,
    });
  }

  if (options.length < QUESTION_LIMITS.minOptions) return null;

  // Rules 2 and 3: exactly one recommended, always. The recommended option is
  // the wizard's initial highlight, so "none" and "several" are both unusable.
  const firstRecommended = options.findIndex((o) => o.recommended);
  options.forEach((option, i) => {
    option.recommended = i === (firstRecommended === -1 ? 0 : firstRecommended);
  });

  // Rule 5: the synthetic free-text escape hatch, unless the model already
  // supplied something that reads as one.
  if (!options.some((o) => /^other/i.test(o.label))) {
    options.push({ label: OTHER_OPTION_LABEL, description: '', recommended: false, isOther: true });
  } else {
    const existing = options.find((o) => /^other/i.test(o.label))!;
    existing.isOther = true;
  }

  const id = asString(src.id).trim();
  return {
    id: id.length > 0 ? id : `q${index + 1}`,
    header: clampText(src.header, QUESTION_LIMITS.headerChars) || `Q${index + 1}`,
    question: text,
    options,
    allowMultiple: src.allowMultiple === true,
  };
}

// ---------------------------------------------------------------------------
// normalizePlan
// ---------------------------------------------------------------------------

/**
 * Repair a submitted plan. Returns `null` only when no step survives — the one
 * hard failure, because there is then nothing left to review.
 *
 * A plan that is one step over the cap is still a plan, and rejecting it costs a
 * full research turn to regain nothing. Truncation is silent to the model but
 * VISIBLE to the user: the review overlay's position indicator counts the real
 * rows, so a clipped plan cannot masquerade as complete.
 */
export function normalizePlan(raw: unknown): NormalizedPlan | null {
  const src = asRecord(raw);

  // Same drop-first, cap-second discipline as `nonEmptyStrings`: a blank-titled
  // step is noise, and letting it consume one of the twenty slots would silently
  // discard a real step at the other end.
  const steps: { title: string; detail: string }[] = [];
  for (const rawStep of asArray(src.steps)) {
    const record = asRecord(rawStep);
    const title = clampText(record.title, PLAN_LIMITS.stepTitleChars);
    if (title.length === 0) continue;
    steps.push({ title, detail: clampText(record.detail, PLAN_LIMITS.stepDetailChars) });
    if (steps.length === PLAN_LIMITS.maxSteps) break;
  }
  if (steps.length === 0) return null;

  return {
    title: clampText(src.title, PLAN_LIMITS.titleChars) || 'Untitled plan',
    summary: clampText(src.summary, PLAN_LIMITS.summaryChars),
    steps,
    // Exact deduplication, NOT case-insensitive: POSIX paths are case-sensitive
    // and two casings are two files.
    filesTouched: nonEmptyStrings(src.filesTouched, PLAN_LIMITS.maxFiles, true),
    risks: nonEmptyStrings(src.risks, PLAN_LIMITS.maxRisks),
    openQuestions: nonEmptyStrings(src.openQuestions, PLAN_LIMITS.maxOpenQuestions),
  };
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

export interface AnswersResultShape {
  answers: Answer[];
  cancelled: boolean;
  roundsUsed: number;
  roundsRemaining: number;
}

/**
 * Render the `ask_user` result: one human-readable line so the transcript
 * preview is legible without parsing, then the JSON the model reads.
 *
 * `asked` is passed separately rather than derived from `answers.length`
 * because a cancelled wizard returns fewer answers than it asked for, and
 * "answered 1 of 3" is the whole information content of that line.
 */
export function formatAnswersResult(shape: AnswersResultShape, asked: number): string {
  const headline = shape.cancelled
    ? 'User dismissed the questions.'
    : `User answered ${shape.answers.length} of ${asked} questions.`;
  const guidance = shape.cancelled
    ? ' Proceed with your best assumptions and say what you assumed.'
    : '';
  return `${headline}${guidance}\n${JSON.stringify(shape, null, 2)}`;
}
