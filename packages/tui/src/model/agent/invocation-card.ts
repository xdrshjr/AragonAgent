/**
 * Invocation cards (tui-invocation-cards): what a transcript shows INSTEAD of the
 * system prompt a command submitted on the user's behalf.
 *
 * Pure and total: no IO, no React, no Ink, nothing but `import type`. ASCII ONLY -
 * `src/agent/**` new files sit inside the `glyphs.test.ts` scan scope.
 *
 * ONE CONSTRUCTOR (I-3). `buildInvocationCard` is the only function that turns raw
 * command-layer material into a card, `App.submitMessage` is its only caller, and
 * `sanitizeInvocationCard` (the session-load path) shares its normaliser so a card
 * written today and a card read back tomorrow cannot drift apart.
 *
 * ORDER IS REDACT -> NORMALISE -> LIMIT, and it is the load-bearing part (I-6). Cut
 * first and a secret that straddles the cut leaves a prefix shorter than the
 * redaction patterns' minimum length: the half-key sails through into the
 * transcript, the session file and the exit replay.
 */

export type InvocationVariant = 'skill' | 'team' | 'todo' | 'govern';

/** Everything one card needs; persisted, queued and rendered in this one shape. */
export interface InvocationCard {
  readonly variant: InvocationVariant;
  /** Skill name / 'continue' / 'resume'; '' for team. */
  readonly name: string;
  /** What the user typed (or its equivalent), redacted and capped; also `Entry.text`. */
  readonly commandLine: string;
  /** The user's own words (args / brief), redacted and trimmed; may be ''. */
  readonly input: string;
  /** Characters cut from `input`; 0 when nothing was cut. */
  readonly inputHidden: number;
  /** Fact fragments, each at most `factMaxChars`, at most `factsMax` of them. */
  readonly facts: readonly string[];
  /** One disclosure sentence. */
  readonly note?: string;
}

/**
 * The renderer, the height estimate and the loader all read THESE numbers (I-4).
 * A card's height is a function of its data and these limits, so it is bounded:
 * header + `inputMaxLines` + hidden tail + note.
 */
export const INVOCATION_LIMITS = {
  commandLineMaxChars: 2000,
  inputMaxChars: 480,
  inputMaxLines: 8,
  nameMaxChars: 64,
  factsMax: 5,
  factMaxChars: 28,
  noteMaxChars: 140,
} as const;

/**
 * Raw material from the command layer: NOT redacted, NOT trimmed. Commands must not
 * cut or scrub it themselves - both happen exactly once, in `buildInvocationCard`.
 */
export interface InvocationCardInput {
  variant: InvocationVariant;
  name?: string;
  commandLine: string;
  input?: string;
  facts?: readonly string[];
  note?: string;
}

const VARIANTS: readonly InvocationVariant[] = ['skill', 'team', 'todo', 'govern'];

// C0 except TAB (\x09) and LF (\x0a), then DEL and C1 (which includes the 8-bit CSI
// \x9b). Matches the range `QueueOverlay` strips, so the card is no more permissive.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

const CAP_MARK = '...';

/** Cut at a code-point boundary: a surrogate pair is never split. */
function sliceCodePoints(text: string, count: number): string {
  if (count <= 0) return '';
  if (text.length <= count) return text;
  let end = count;
  const last = text.charCodeAt(end - 1);
  // A high surrogate at the cut would orphan its low half.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function countCodePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** CRLF and bare CR to LF (a bare CR returns Ink's cursor to column 0), then strip controls. */
function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '');
}

function capCommandLine(text: string): string {
  const max = INVOCATION_LIMITS.commandLineMaxChars;
  if (text.length <= max) return text;
  return sliceCodePoints(text, max - CAP_MARK.length) + CAP_MARK;
}

function capInput(text: string): { input: string; hidden: number } {
  const trimmed = text.trim();
  if (trimmed === '') return { input: '', hidden: 0 };
  const lines = trimmed.split('\n');
  let kept = lines.length > INVOCATION_LIMITS.inputMaxLines
    ? lines.slice(0, INVOCATION_LIMITS.inputMaxLines).join('\n') : trimmed;
  kept = sliceCodePoints(kept, INVOCATION_LIMITS.inputMaxChars).trimEnd();
  return { input: kept, hidden: countCodePoints(trimmed) - countCodePoints(kept) };
}

function capSingleLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (countCodePoints(flat) <= max) return flat;
  return sliceCodePoints(flat, max - CAP_MARK.length) + CAP_MARK;
}

function capFacts(facts: readonly string[]): string[] {
  return facts
    .map((fact) => capSingleLine(fact, INVOCATION_LIMITS.factMaxChars))
    .filter((fact) => fact !== '')
    .slice(0, INVOCATION_LIMITS.factsMax);
}

function capNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const capped = capSingleLine(note, INVOCATION_LIMITS.noteMaxChars);
  return capped === '' ? undefined : capped;
}

/** Shared by the write path and the load path so the two cannot diverge. */
function assemble(parts: {
  variant: InvocationVariant; name: string; commandLine: string; input: string;
  facts: readonly string[]; note: string | undefined;
}): InvocationCard {
  const { input, hidden } = capInput(normalizeText(parts.input));
  const note = capNote(normalizeText(parts.note ?? ''));
  return {
    variant: parts.variant,
    name: capSingleLine(normalizeText(parts.name), INVOCATION_LIMITS.nameMaxChars),
    commandLine: capCommandLine(normalizeText(parts.commandLine).trim()),
    input,
    inputHidden: hidden,
    facts: capFacts(parts.facts.map(normalizeText)),
    ...(note !== undefined ? { note } : {}),
  };
}

/**
 * Total, never throws. `redact` is injected (the same closure `Command:` echo uses) so
 * this module depends on nothing; the default is the identity for tests and the loader.
 */
export function buildInvocationCard(
  input: InvocationCardInput, redact: (text: string) => string = (text) => text,
): InvocationCard {
  const scrub = (text: string | undefined): string => {
    if (text === undefined) return '';
    try { return redact(text); } catch { return ''; }
  };
  return assemble({
    variant: input.variant,
    name: scrub(input.name),
    commandLine: scrub(input.commandLine),
    input: scrub(input.input),
    facts: (input.facts ?? []).map((fact) => scrub(fact)),
    note: input.note === undefined ? undefined : scrub(input.note),
  });
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Session-load path: `null` for anything that is not a plausible card, so the caller
 * drops the field and the entry degrades to a plain user message (I-7). Re-derives
 * `inputHidden` from nothing - it trusts the stored count only when it is a sane integer.
 */
export function sanitizeInvocationCard(value: unknown): InvocationCard | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const variant = VARIANTS.find((candidate) => candidate === raw.variant);
  const commandLine = asString(raw.commandLine);
  if (variant === undefined || commandLine === null) return null;
  const name = asString(raw.name) ?? '';
  const input = asString(raw.input) ?? '';
  const facts = Array.isArray(raw.facts)
    ? raw.facts.filter((fact): fact is string => typeof fact === 'string') : [];
  const note = asString(raw.note) ?? undefined;
  const card = assemble({ variant, name, commandLine, input, facts, note });
  // A stored card that was already capped must keep its recorded `inputHidden`; the
  // re-cap above can only ever add to it.
  const stored = raw.inputHidden;
  const storedHidden = typeof stored === 'number' && Number.isInteger(stored) && stored > 0
    ? Math.min(stored, 10_000_000) : 0;
  return { ...card, inputHidden: Math.max(card.inputHidden, storedHidden) };
}

/**
 * Emergency kill switch (`ARAGON_NO_INVOCATION_CARDS=1`): every command and the App fall
 * back to the pre-card behaviour. Read at call time, not import time, so a test (or a
 * wrapper script) that sets the variable after load is honoured.
 */
export function invocationCardsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARAGON_NO_INVOCATION_CARDS !== '1';
}
