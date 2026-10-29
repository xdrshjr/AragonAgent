/**
 * The settlement card's layout (governance-mode section 10.4): what a
 * `kind: 'governance'` transcript entry says, as pure data, plus the plain-text export
 * of the same card.
 *
 * Pure and total. ASCII ONLY.
 *
 * WIDTH-INDEPENDENT ON PURPOSE. A transcript entry is measured by two parties that must
 * agree - `virtual-window.ts::estimateEntryRows` and the Ink tree - and neither is handed
 * the terminal width for a card (`EntryView` has no `cols`). Every line here is
 * single-row and rendered `wrap="truncate"`, so the card's HEIGHT is a function of the
 * data alone (`governanceCardRows`) and the estimate is exact rather than an upper bound.
 * The spec's "narrow terminal -> one plain line per agent" falls out for free: the table
 * is only a fixed prefix (id, role, confirmed) and an elastic delta, so truncation at 40
 * columns leaves exactly `dev1 DEV 115 +15P->...`.
 */

import type { GovernanceCardData } from '../../model/governance/types.js';
import type { Glyphs } from '../glyphs.js';
import { segment, type Segment, type Tone } from '../governance-status.js';
import { CARD_COLUMNS, CARD_TITLE } from '../governance-copy.js';
import { bindVoiceScope, type VoiceContext } from '../tool-voice.js';
import { cellWidth, padCells } from './cells.js';

export interface CardTableRow {
  key: string;
  cells: Segment[][];
}

export interface GovernanceCardLayout {
  /** Rail / headline tone for the whole card. */
  tone: Tone;
  title: Segment[];
  headline: Segment[] | null;
  /**
   * Fixed prefix widths: id, role, confirmed. The delta cell is elastic. When the card
   * carries persona names, a leading name cell (`NAME_CELLS`) is drawn in front of them
   * and is NOT listed here (the three-tuple is a pre-existing shape).
   */
  widths: [number, number, number];
  tableHeader: Segment[][] | null;
  rows: CardTableRow[];
  notes: Segment[] | null;
  height: number;
}

const TONE_OF_CARD: Readonly<Record<GovernanceCardData['tone'], Tone>> = {
  ok: 'ok',
  warn: 'warn',
  error: 'error',
  info: 'govern',
};

export function cardTone(card: GovernanceCardData): Tone {
  return TONE_OF_CARD[card.tone];
}

/** The glyph in front of the headline: what the card's verdict looks like at a glance. */
function toneGlyph(tone: GovernanceCardData['tone'], glyphs: Glyphs): string {
  switch (tone) {
    case 'ok':
      return glyphs.check;
    case 'warn':
      return glyphs.warn;
    case 'error':
      return glyphs.times;
    case 'info':
      return glyphs.bullet;
  }
}

/**
 * Colour the signed tokens of a delta text: `+15P->C D1  +10 D12  -20 D5`. Gains read in
 * the success tone, losses in the error tone, event codes stay muted. The spelling comes
 * from the engine (`deltaText`), this only paints it.
 */
export function colorizeDelta(text: string): Segment[] {
  return text
    .split(/(\s+)/)
    .filter((part) => part !== '')
    .map((part): Segment => {
      if (/^\+\d/.test(part)) return segment(part, 'ok');
      if (/^-\d/.test(part)) return segment(part, 'error');
      return segment(part, 'muted');
    });
}

function titleText(card: GovernanceCardData, glyphs: Glyphs): string {
  const detail = card.title.trim();
  if (detail === '') return CARD_TITLE;
  return /^governance\b/i.test(detail) ? detail : `${CARD_TITLE} ${glyphs.midDot} ${detail}`;
}

/** A persona name (<= 6) plus one cell of air; present only when a voice is given. */
const NAME_CELLS = 7;
const ID_MIN = 6;
const ID_MAX = 14;
const ROLE_CELLS = 6;
const CONFIRMED_CELLS = 11;

export function buildGovernanceCardLayout(
  card: GovernanceCardData,
  glyphs: Glyphs,
  voice?: VoiceContext,
): GovernanceCardLayout {
  // NAMES ARE RESOLVED IN THE RUN'S OWN SCOPE (`card.runId`), the one the live roster uses,
  // so a settlement card names `dev1-r1` exactly as the panel did while it ran.
  const nameOf = voice === undefined ? null : bindVoiceScope(voice, card.runId).nameOf;
  const nameCell = (text: string, muted: boolean): Segment[][] => nameOf === null
    ? []
    : [[segment(padCells(text, NAME_CELLS), muted ? 'muted' : 'primary', !muted)]];
  const tone = cardTone(card);
  const idCells = Math.min(
    ID_MAX,
    Math.max(ID_MIN, ...card.rows.map((row) => cellWidth(row.id) + 2)),
  );
  const headlineText = card.headline.trim();
  const rows: CardTableRow[] = card.rows.map((row, index) => ({
    key: `${row.id}:${index}`,
    cells: [
      ...nameCell(nameOf === null ? '' : nameOf(row.id), false),
      [segment(padCells(row.id, idCells), 'primary')],
      [segment(padCells(row.role, ROLE_CELLS), 'muted')],
      [segment(
        padCells(row.confirmed === null ? '-' : String(Math.round(row.confirmed)), CONFIRMED_CELLS),
        'text',
        true,
      )],
      colorizeDelta(row.deltaText),
    ],
  }));
  const tableHeader = rows.length === 0
    ? null
    : [
        ...nameCell(CARD_COLUMNS.name, true),
        [segment(padCells(CARD_COLUMNS.id, idCells), 'muted')],
        [segment(padCells(CARD_COLUMNS.role, ROLE_CELLS), 'muted')],
        [segment(padCells(CARD_COLUMNS.confirmed, CONFIRMED_CELLS), 'muted')],
        [segment(CARD_COLUMNS.delta, 'muted')],
      ];
  const notes = card.notes.length === 0
    ? null
    : [segment(`notes: ${card.notes.join('; ')}`, 'muted')];
  return {
    tone,
    title: [segment(titleText(card, glyphs), 'govern', true)],
    headline: headlineText === ''
      ? null
      : [segment(`${toneGlyph(card.tone, glyphs)} `, tone, true), segment(headlineText, 'text')],
    widths: [idCells, ROLE_CELLS, CONFIRMED_CELLS],
    tableHeader,
    rows,
    notes,
    height: governanceCardRows(card),
  };
}

/**
 * The card's row count, from the data alone: title, headline, table header + one row per
 * agent, notes. Exact (not an upper bound) because every line truncates instead of wrapping.
 */
export function governanceCardRows(card: GovernanceCardData): number {
  return 1
    + Number(card.headline.trim() !== '')
    + (card.rows.length > 0 ? 1 + card.rows.length : 0)
    + Number(card.notes.length > 0);
}

/**
 * The card as plain lines for `/export` and `/save` (no colour, ASCII-safe through
 * `glyphs`). The caller indents them; the text matches what the card prints.
 */
export function governanceCardLines(card: GovernanceCardData, glyphs: Glyphs): string[] {
  const layout = buildGovernanceCardLayout(card, glyphs);
  const flat = (segments: readonly Segment[]): string => segments.map((s) => s.text).join('');
  const lines = [flat(layout.title)];
  if (layout.headline) lines.push(flat(layout.headline));
  if (layout.tableHeader) {
    lines.push(layout.tableHeader.map(flat).join('').trimEnd());
    for (const row of layout.rows) lines.push(row.cells.map(flat).join('').trimEnd());
  }
  if (layout.notes) lines.push(flat(layout.notes));
  return lines;
}
