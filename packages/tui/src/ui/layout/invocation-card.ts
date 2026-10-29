/**
 * Invocation card layout (tui-invocation-cards section 3.7): what a `user` entry that
 * carries an `invocation` says, as pure data. No Ink, no React. ASCII ONLY.
 *
 * THE CARD'S HEIGHT IS A FUNCTION OF ITS DATA AND THE USABLE WIDTH (I-4).
 * `InvocationCard.tsx` renders exactly the rows `invocationCardRows` counts, and both
 * read `INVOCATION_LIMITS` plus the one `invocationInputText` below - an estimate that
 * disagrees with the painter is permanent, because an over-estimated entry is never
 * mounted and so never measured (see `virtual-window.ts`).
 */

import type { InvocationCard } from '../../model/agent/invocation-card.js';
import type { Glyphs } from '../glyphs.js';
import { expandTabs } from '../display-tab.js';
import { cellWidth, fitCells } from './cells.js';

/** Colour slots the component maps onto the theme; kept local so this file needs no `Theme`. */
export type InvocationTone = 'label' | 'name' | 'muted';

export interface InvocationSegment {
  text: string;
  tone: InvocationTone;
  bold: boolean;
}

/** Two spaces between the identity (`skill . pdf-forms`) and the facts. */
const FACT_GAP = '  ';

function seg(text: string, tone: InvocationTone, bold = false): InvocationSegment {
  return { text, tone, bold };
}

function segmentsWidth(segments: readonly InvocationSegment[]): number {
  return segments.reduce((sum, part) => sum + cellWidth(part.text), 0);
}

function identitySegments(
  card: InvocationCard, glyphs: Glyphs, name: string,
): InvocationSegment[] {
  const parts = [seg(card.variant, 'label', true)];
  if (name !== '') parts.push(seg(` ${glyphs.midDot} `, 'muted'), seg(name, 'name', true));
  return parts;
}

function factSegments(facts: readonly string[], glyphs: Glyphs): InvocationSegment[] {
  if (facts.length === 0) return [];
  const parts: InvocationSegment[] = [seg(FACT_GAP, 'muted')];
  facts.forEach((fact, index) => {
    if (index > 0) parts.push(seg(` ${glyphs.midDot} `, 'muted'));
    parts.push(seg(fact, 'muted'));
  });
  return parts;
}

/**
 * The header row, already fitted to `usable` columns (RV-10). Narrow terminals drop
 * facts from the right WHOLE before anything else is cut; only when the identity alone
 * is too wide is the name shortened. Ink's `wrap="truncate"` stays on the row as a
 * backstop, but it is never what produces the visible ellipsis.
 */
export function invocationHeaderSegments(
  card: InvocationCard, glyphs: Glyphs, usable: number,
): InvocationSegment[] {
  const width = Math.max(1, Math.floor(usable));
  for (let kept = card.facts.length; kept >= 0; kept -= 1) {
    const candidate = [
      ...identitySegments(card, glyphs, card.name),
      ...factSegments(card.facts.slice(0, kept), glyphs),
    ];
    if (segmentsWidth(candidate) <= width) return candidate;
  }
  const head = identitySegments(card, glyphs, '');
  const room = width - segmentsWidth(head) - cellWidth(` ${glyphs.midDot} `);
  if (card.name !== '' && room > 1) {
    return identitySegments(card, glyphs, fitCells(card.name, room, glyphs.ellipsis));
  }
  return [seg(fitCells(card.variant, width, glyphs.ellipsis), 'label', true)];
}

/** The text painted for `input`: tabs expanded per line, the same rule `UserEntry` follows. */
export function invocationInputText(card: InvocationCard): string {
  return card.input.split('\n').map((line) => expandTabs(line)).join('\n');
}

/** Singular/plural for the hidden-characters tail. */
export function invocationHiddenText(card: InvocationCard, glyphs: Glyphs): string {
  const unit = card.inputHidden === 1 ? 'char' : 'chars';
  return `${glyphs.ellipsis} +${card.inputHidden} ${unit} not shown`;
}

/**
 * Rows the card occupies at `usable` columns. `wrappedRows` is injected by the caller
 * (`virtual-window.ts` owns the one wrapping rule) so this file stays import-cycle free.
 */
export function invocationCardRows(
  card: InvocationCard, usable: number, wrappedRows: (text: string, usable: number) => number,
): number {
  const inputRows = card.input === '' ? 0 : wrappedRows(invocationInputText(card), usable);
  return 1 + inputRows + (card.inputHidden > 0 ? 1 : 0) + (card.note ? 1 : 0);
}

const REPLAY_INDENT = '    ';

/**
 * The lines the exit replay / export prints UNDER the command line (section 2.4):
 * a bracketed fact line, and the disclosure note when there is one. Plain ASCII
 * separators - the replay is pasted into issues and must survive any terminal.
 */
export function invocationCardLines(card: InvocationCard): string[] {
  const identity = card.name === '' ? card.variant : `${card.variant} ${card.name}`;
  const detail = card.facts.length === 0 ? identity : `${identity} ${card.facts.join(' - ')}`;
  const lines = [`${REPLAY_INDENT}[${detail}]`];
  if (card.note) lines.push(`${REPLAY_INDENT}${card.note}`);
  return lines;
}
