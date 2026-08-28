/**
 * `normalizeCritique` — turn whatever the fast model wrote into one of three
 * outcomes (fast-model-tier §3.5.3). PURE: no I/O, no state.
 *
 * ASCII ONLY: `src/fast/**` is inside the glyph scanner's scope.
 */

/**
 * What a review amounted to.
 *
 * `ok` and `empty` are NOT INJECTED (D-16). They still produce a transcript
 * entry and a log record, so the user can see the harness is alive, but the lead
 * pays no context for the message "nothing to say".
 */
export type Critique =
  | { kind: 'ok' }
  | { kind: 'advice'; text: string }
  | { kind: 'empty' };

/** Strip a fenced code block wrapper the model may have put around its prose. */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const withoutOpen = trimmed.replace(/^```[a-zA-Z0-9_-]*\s*\r?\n?/, '');
  return withoutOpen.replace(/\r?\n?```\s*$/, '').trim();
}

/**
 * THE ON-TRACK TEST IS A NORMALIZED REGEX, NEVER STRING EQUALITY (D-17).
 *
 * The system prompt asks for the exact string `OK - on track.`, and models
 * mostly comply - but one that writes `Ok, on track` would, under an equality
 * test, be classified as ADVICE and injected into the main context on every
 * cycle, forever, saying nothing. That is worse than having no reviewer: it is a
 * permanent context tax that looks like the feature working.
 *
 * So: trim, lowercase, drop trailing punctuation, then `/^ok\b.*on track/`.
 * `'OK, but the tests are failing'` still classifies as advice, because it does
 * not say "on track".
 */
export function isOnTrack(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!\s]+$/, '')
    .replace(/\s+/g, ' ');
  return /^ok\b.*on track/.test(normalized);
}

/**
 * Normalize and classify one raw review answer.
 *
 * @param raw      Whatever the model returned.
 * @param maxChars `fast.reviewMaxChars` — the ceiling the user chose on how much
 *                 of their own context a critique may spend.
 */
export function normalizeCritique(raw: string, maxChars: number): Critique {
  const stripped = stripFences(raw ?? '');
  // Whitespace is collapsed BEFORE the length test: a model that answers with
  // four blank lines and a sentence must not spend its budget on the blanks.
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return { kind: 'empty' };
  if (isOnTrack(collapsed)) return { kind: 'ok' };

  const limit = Math.max(1, Math.floor(maxChars) || 1);
  if (collapsed.length <= limit) return { kind: 'advice', text: collapsed };

  // Clamp on a word boundary when one is close enough that the sentence still
  // reads; otherwise a hard cut, because a critique is prose and a mid-word
  // truncation is what makes advice look like corruption.
  const cut = collapsed.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  const text = space > limit * 0.6 ? cut.slice(0, space) : cut;
  return { kind: 'advice', text };
}
