/**
 * Secret redaction — two passes, both mandatory.
 *
 *   1. STRUCTURAL. Walk `data` and blank any value whose KEY looks like a
 *      credential, whatever the value contains.
 *   2. TEXTUAL. Scan `msg` and every string leaf for known key formats and for
 *      every literal in the secret registry.
 *
 * Neither pass subsumes the other. Structure alone misses a key pasted into a
 * URL or echoed back inside an error message. Text alone misses a
 * custom-endpoint key that matches none of the vendor formats — which is
 * exactly why the registry backstop exists, and exactly why it must be live
 * rather than a startup snapshot (see `secret-registry.ts`).
 *
 * This module is pure: same input, same output, no I/O, no clock. It is the one
 * part of the logging subsystem whose correctness can be established outright,
 * and it guards the one failure that cannot be undone once it reaches disk.
 */

import type { LogRecord } from './logger.js';

export const REDACTED = '«redacted»';
export const TRUNCATED = '«truncated»';

/** Value keys that are credentials regardless of what they hold. */
const SECRET_KEY_PATTERN = /(api[-_]?key|token|secret|password|authorization|credential)/i;

/**
 * Known key shapes. Anthropic, OpenAI (and compatible endpoints), Google, plus
 * any `Authorization: Bearer …` header value that survived pass 1.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AIza[A-Za-z0-9_-]{28,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
];

/**
 * Bounds on the structural walk. A tool result can be an arbitrarily deep and
 * wide object; without a ceiling, redacting one log record could stall the CLI.
 * Exceeding either bound yields `«truncated»`, never the raw value.
 */
const MAX_DEPTH = 6;
const MAX_NODES = 500;

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  // `getSecrets()` returns longest-first, so a key that is a prefix of another
  // cannot leave its tail behind. Split/join rather than a built regex: the
  // literals are arbitrary and escaping them is one more thing to get wrong.
  for (const secret of secrets) {
    if (secret.length > 0 && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

interface WalkBudget {
  nodes: number;
}

function redactValue(
  value: unknown,
  secrets: readonly string[],
  depth: number,
  budget: WalkBudget,
): unknown {
  if (depth > MAX_DEPTH) return TRUNCATED;
  if (budget.nodes <= 0) return TRUNCATED;
  budget.nodes -= 1;

  if (typeof value === 'string') return redactText(value, secrets);
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets, depth + 1, budget));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key)
      ? REDACTED
      : redactValue(item, secrets, depth + 1, budget);
  }
  return out;
}

/**
 * Redact a record in place of serialising it raw. Returns a new record; the
 * caller's object is untouched so a failed write cannot leave a half-redacted
 * value behind for a retry to publish.
 */
export function redactRecord(record: LogRecord, secrets: readonly string[]): LogRecord {
  const budget: WalkBudget = { nodes: MAX_NODES };
  const data = record.data
    ? (redactValue(record.data, secrets, 1, budget) as Record<string, unknown>)
    : undefined;
  return {
    ...record,
    msg: redactText(record.msg, secrets),
    ...(data ? { data } : {}),
  };
}
