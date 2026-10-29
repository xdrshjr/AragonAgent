/**
 * The event catalogue - Appendix A of the design, 44 rows (governance-mode AC-15).
 *
 * ASCII ONLY (`governance/` is glyph-scanned).
 *
 * THIS TABLE IS THE GOLDEN SOURCE. `governance-ledger.test.ts` pins every row against
 * the reference spec (`token-economy-rules.md` v2.0); a change here is a scoring-rule
 * change, so it must be mirrored in the design document and the golden test in the same
 * commit. Nothing else in the tree may hard-code a delta: settlement, RCA expansion and
 * the inspector tool all look values up here, which is what keeps the engine's
 * automatic events and the inspector's judgement events on ONE accounting path (I-G7).
 *
 * Settlement semantics (design 5.3 / RV-9):
 *   provisional (P) - positive; held in escrow until integration passes; clawback-able.
 *   confirmed   (C) - positive; straight into `confirmed`; not clawback-able.
 *   immediate   (I) - positive scores go straight into `confirmed` (same as C, but the
 *                     reference spec calls the column "Immediate"); negative scores are
 *                     deducted from `confirmed` at once.
 */

export type EventRole = 'DEV' | 'REV' | 'TEST' | 'ALL';
export type Settlement = 'provisional' | 'confirmed' | 'immediate';
/**
 * Who may book an event: E engine, A engine on a mechanical signature (appealable),
 * K a claim ruled on by the inspector, S inspector judgement (evidence required),
 * R inspector root-cause analysis expanded by the engine.
 */
export type Bookkeeper = 'E' | 'A' | 'K' | 'S' | 'R';

export const EVENT_CODES = [
  'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13', 'D14',
  'D15', 'D16', 'D17', 'D18',
  'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12',
  'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10',
  'C1', 'C2', 'C3', 'C4',
] as const;

export type EventCode = (typeof EVENT_CODES)[number];

export interface EventDef {
  code: EventCode;
  role: EventRole;
  /** The catalogue delta. C2 is -5 for everyone; the -2 relief is applied by RCA. */
  delta: number;
  settlement: Settlement;
  bookers: readonly Bookkeeper[];
  /** Short English title, ASCII. Used in ledger rows and the board. */
  title: string;
}

function def(
  code: EventCode,
  role: EventRole,
  delta: number,
  settlement: Settlement,
  bookers: readonly Bookkeeper[],
  title: string,
): EventDef {
  return { code, role, delta, settlement, bookers, title };
}

const ROWS: readonly EventDef[] = [
  // --- Development D1-D18 ---
  def('D1', 'DEV', 15, 'provisional', ['E'], 'review passed with no changes'),
  def('D2', 'DEV', 5, 'provisional', ['E'], 'review passed with minor fixes'),
  def('D3', 'DEV', 10, 'provisional', ['E'], 'all tests passed'),
  def('D4', 'DEV', 5, 'provisional', ['E'], 'fully matches the specification'),
  def('D5', 'DEV', -20, 'immediate', ['E'], 'code sent back for rework'),
  def('D6', 'DEV', -40, 'immediate', ['S'], 'introduced a security vulnerability'),
  def('D7', 'DEV', -25, 'immediate', ['E'], 'specification mismatch'),
  def('D8', 'DEV', -30, 'immediate', ['E'], 'same problem rejected twice'),
  def('D9', 'DEV', -20, 'immediate', ['E'], 'incomplete implementation'),
  def('D10', 'DEV', 20, 'provisional', ['S'], 'proactive excellence'),
  def('D11', 'DEV', -30, 'immediate', ['E'], 'skeleton submission'),
  def('D12', 'DEV', 10, 'confirmed', ['E'], 'integration passed (own code clean)'),
  def('D13', 'DEV', -25, 'immediate', ['R'], 'integration failure (root cause)'),
  def('D14', 'DEV', -20, 'immediate', ['R', 'S'], 'contract violation (producer)'),
  def('D15', 'DEV', -10, 'immediate', ['R', 'S'], 'contract violation (consumer unverified)'),
  def('D16', 'DEV', 10, 'confirmed', ['S'], 'proactive contract verification'),
  def('D17', 'DEV', -15, 'immediate', ['A', 'S'], 'scope narrowing'),
  def('D18', 'DEV', 10, 'confirmed', ['S'], 'integration repair contribution'),
  // --- Review R1-R12 ---
  def('R1', 'REV', 10, 'provisional', ['E'], 'high quality review (no missed defects)'),
  def('R2', 'REV', 10, 'immediate', ['E'], 'found a valid problem'),
  def('R3', 'REV', 5, 'immediate', ['S'], 'efficient review'),
  def('R4', 'REV', -15, 'immediate', ['K'], 'missed defect found by testing'),
  def('R5', 'REV', -10, 'immediate', ['K', 'E'], 'false positive feedback'),
  def('R6', 'REV', -5, 'immediate', ['S'], 'vague or unactionable feedback'),
  def('R7', 'REV', -15, 'immediate', ['K'], 'did not flag an incomplete implementation'),
  def('R8', 'REV', 5, 'immediate', ['S'], 'identified proactive excellence'),
  def('R9', 'REV', -20, 'immediate', ['R'], 'missed integration compatibility'),
  def('R10', 'REV', 10, 'confirmed', ['S'], 'performed contract verification'),
  def('R11', 'REV', 5, 'confirmed', ['S'], 'cross-agent impact analysis'),
  def('R12', 'REV', -10, 'immediate', ['A', 'S'], 'rubber-stamp integration check'),
  // --- Testing T1-T10 ---
  def('T1', 'TEST', 10, 'provisional', ['E'], 'full requirement traceability'),
  def('T2', 'TEST', 10, 'immediate', ['K'], 'found a defect the review missed'),
  def('T3', 'TEST', 5, 'immediate', ['S'], 'high quality test cases'),
  def('T4', 'TEST', -15, 'immediate', ['R'], 'missed a defect found at integration'),
  def('T5', 'TEST', -10, 'immediate', ['K', 'S'], 'false positive defect or claim'),
  def('T6', 'TEST', -10, 'immediate', ['E'], 'incomplete requirement traceability'),
  def('T7', 'TEST', 10, 'immediate', ['K'], 'found an incomplete implementation the review missed'),
  def('T8', 'TEST', 10, 'confirmed', ['S'], 'wrote integration boundary tests'),
  def('T9', 'TEST', 15, 'confirmed', ['S'], 'found an integration problem before integration'),
  def('T10', 'TEST', -15, 'immediate', ['R'], 'did not test the integration boundary'),
  // --- Collective C1-C4 (per active DEV/REV/TEST) ---
  def('C1', 'ALL', 5, 'confirmed', ['E'], 'integration passed first time'),
  def('C2', 'ALL', -5, 'immediate', ['E', 'R'], 'integration failed (first)'),
  def('C3', 'ALL', -10, 'immediate', ['E'], 'repeated integration failure'),
  def('C4', 'ALL', -15, 'immediate', ['R'], 'integration disaster (systemic)'),
];

export const EVENTS_TABLE: Readonly<Record<EventCode, EventDef>> = Object.freeze(
  Object.fromEntries(ROWS.map((r) => [r.code, r])) as Record<EventCode, EventDef>,
);

export function isEventCode(value: unknown): value is EventCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EVENTS_TABLE, value);
}

export function eventDef(code: EventCode): EventDef {
  return EVENTS_TABLE[code];
}

/** True when the inspector may book this code through `ledger_apply` (judgement events). */
export function isInspectorBookable(code: EventCode): boolean {
  return EVENTS_TABLE[code].bookers.includes('S');
}

/** The codes `ledger_apply` accepts, in catalogue order. Used in refusal texts. */
export function inspectorBookableCodes(): EventCode[] {
  return EVENT_CODES.filter(isInspectorBookable);
}
