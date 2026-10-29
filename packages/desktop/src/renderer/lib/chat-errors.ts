/**
 * Which actionable error condition a `notice` entry of level `error` describes.
 *
 * The engine does not attach a machine code to a notice; it renders its own wording (see
 * `formatStreamError` in the view model and `AgentController.preflight`). So the matcher keys
 * on that wording - and, where the engine exports the phrase as a constant, on the constant
 * itself - never on text invented here. A phrase that stops matching degrades to "an error
 * notice with a Copy button", which is why the cases are pinned by a unit test.
 */

import { CONTEXT_OVERFLOW_NOTICE_PREFIX, type Entry } from '@aragon-agent/tui/model/agent/reducer';

export type ErrorCondition =
  | 'model-not-configured'
  | 'auth'
  | 'rate-limit'
  | 'context-overflow'
  | 'no-response';

export type ErrorAction = 'open-models' | 'retry' | 'compact-retry';

export interface ErrorClassification {
  condition: ErrorCondition;
  actions: ErrorAction[];
}

/** Opening words of the engine's "run produced nothing" notice. */
const NO_RESPONSE_PREFIX = 'The run ended without producing a response';

const RULES: ReadonlyArray<{ condition: ErrorCondition; test: RegExp; actions: ErrorAction[] }> = [
  {
    // preflight: `No API key for "x"`, `Provider "x" has no adapter`; plus the stable code name.
    condition: 'model-not-configured',
    test: /MODEL_NOT_CONFIGURED|\bNo API key for\b|\bhas no adapter\b|\bno model (is )?configured\b/i,
    actions: ['open-models'],
  },
  {
    condition: 'context-overflow',
    test: new RegExp(`^${CONTEXT_OVERFLOW_NOTICE_PREFIX}|context_overflow|context window`, 'i'),
    actions: ['compact-retry', 'retry'],
  },
  {
    condition: 'auth',
    test: /^Authentication failed|\bHTTP 40[13]\b|\b40[13]\b.*(unauthori[sz]ed|forbidden|invalid)|invalid api key/i,
    actions: ['open-models', 'retry'],
  },
  {
    condition: 'rate-limit',
    test: /^Rate limited|^Provider overloaded|\b429\b|rate.?limit|overloaded/i,
    actions: ['retry'],
  },
  {
    condition: 'no-response',
    test: new RegExp(`^${NO_RESPONSE_PREFIX}`),
    actions: ['open-models', 'retry'],
  },
];

export function classifyErrorNotice(text: string): ErrorClassification | null {
  for (const rule of RULES) {
    if (rule.test.test(text)) return { condition: rule.condition, actions: rule.actions };
  }
  return null;
}

/**
 * The text to re-submit for "Retry": the last typed user message.
 *
 * `null` when the last user entry came from an invocation card (a skill / team command): its
 * `text` is the command line shown to the user, NOT the prompt that went to the model, and
 * feeding it back would run a different thing than the one that failed.
 */
export function findRetryText(entries: readonly Entry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind === 'user') return entry.invocation ? null : entry.text;
  }
  return null;
}
