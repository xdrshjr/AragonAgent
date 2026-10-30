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
  | 'no-response'
  | 'image-refused';

export type ErrorAction = 'open-models' | 'retry' | 'compact-retry' | 'send-as-paths' | 'no-image-retry';

/** What the host's tables and the user's own override say about the session's model. */
export type ImageSupport = 'yes' | 'no' | 'unknown';

export interface ErrorClassification {
  condition: ErrorCondition;
  actions: ErrorAction[];
}

/** Opening words of the engine's "run produced nothing" notice. */
const NO_RESPONSE_PREFIX = 'The run ended without producing a response';

/**
 * A 400 that complains about the SIZE of a picture is not "this model cannot see images": it is
 * solved by sending a smaller one, and marking the model as blind for it would be a wrong, lasting
 * decision. Checked before the image-refused rule matches.
 */
const IMAGE_SIZE_COMPLAINT =
  /too large|too big|exceeds?\b|size limit|maximum (?:image |file |request )?(?:size|dimension|resolution)|payload|\b\d+(?:\.\d+)?\s?(?:mb|kb|bytes)\b|\bdimensions?\b/i;

const RULES: ReadonlyArray<{ condition: ErrorCondition; test: RegExp; actions: ErrorAction[] }> = [
  {
    // A provider refusing a request because of a picture in it ("invalid_request ... image ...").
    // Deliberately narrow: it needs both an invalid-request word and an image word.
    condition: 'image-refused',
    test: /(invalid[_ ]request|\b400\b|bad request).*\b(image|images|vision|multimodal|image_url)\b|\b(image|images|vision|multimodal)\b.*(not supported|unsupported|does not support|cannot)/i,
    actions: ['send-as-paths', 'retry'],
  },
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
    if (rule.condition === 'image-refused' && IMAGE_SIZE_COMPLAINT.test(text)) continue;
    if (rule.test.test(text)) return { condition: rule.condition, actions: rule.actions };
  }
  return null;
}

/**
 * The buttons to show, given what is known about the model.
 *
 * A refused picture on a model that is `unknown` / `no` gets the single "this model cannot see
 * images" recovery (it records that and resends as paths). On a `yes` model the refusal more likely
 * comes from a gateway that drops images, so only the one-off resend is offered and nothing is
 * written down about the model (completion spec R-1, RV-6).
 */
export function actionsFor(classification: ErrorClassification, support: ImageSupport): ErrorAction[] {
  if (classification.condition !== 'image-refused' || support === 'yes') return classification.actions;
  return classification.actions.map((action) => (action === 'send-as-paths' ? 'no-image-retry' : action));
}

/** A line of small print under the buttons, as an i18n key, or null. */
export function noticeHintKey(classification: ErrorClassification, support: ImageSupport): string | null {
  if (classification.condition !== 'image-refused') return null;
  return support === 'yes' ? 'chat.error.hint.gateway' : 'chat.error.hint.newMessage';
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
