/**
 * `normalizeAcceptance` — the acceptance table's repair rules
 * (todo-acceptance-criteria AC-1..AC-9, AC-43).
 *
 * Every case here is a rule from §6.2.1, in the order that section states them,
 * because the ORDER is the semantics: `enabled` before `undefined`, `undefined`
 * before `Array.isArray`, drop before cap, and restore before truncation.
 */

import { describe, expect, it } from 'vitest';
import { normalizeAcceptance } from '../model/todo/acceptance.js';
import { ACCEPT_LIMITS } from '../model/todo/limits.js';
import type { AcceptanceItem } from '../model/todo/types.js';

const ON = { enabled: true } as const;
const OFF = { enabled: false } as const;

function criterion(content: string, overrides: Partial<AcceptanceItem> = {}): AcceptanceItem {
  return { content, check: '', status: 'pending', evidence: '', ...overrides };
}

describe('normalizeAcceptance', () => {
  it('AC-1: an empty list is an empty table with nothing to repair', () => {
    const result = normalizeAcceptance([], [criterion('old', { status: 'passed', evidence: 'saw it' })], ON);
    expect(result.items).toEqual([]);
    expect(result.repairs).toEqual([]);
  });

  it('AC-2: a verdict without evidence drops back to unchecked, and says why', () => {
    const result = normalizeAcceptance([criterion('npm test passes', { status: 'passed' })], [], ON);
    expect(result.items[0]!.status).toBe('pending');
    expect(result.repairs).toHaveLength(1);
    expect(result.repairs[0]).toContain('no evidence');
  });

  it('AC-5a: a re-sent `pending` keeps the earlier verdict, once', () => {
    const previous = [criterion('npm test passes', { status: 'passed', evidence: '212 green' })];
    const payload = [criterion('npm test passes', { status: 'pending' })];
    const first = normalizeAcceptance(payload, previous, ON);
    expect(first.items[0]!.status).toBe('passed');
    expect(first.items[0]!.evidence).toBe('212 green');
    expect(first.repairs.join(' ')).toContain('kept its earlier verdict');

    // P2-4: the model cannot know the server restored anything, so it will send the
    // same row again. The note must not be charged twice.
    const seen = new Set<string>();
    const again = normalizeAcceptance(payload, previous, { enabled: true, restoredNotes: seen });
    const third = normalizeAcceptance(payload, previous, { enabled: true, restoredNotes: seen });
    expect(again.repairs.join(' ')).toContain('kept its earlier verdict');
    expect(third.repairs).toEqual([]);
  });

  it('AC-5b: a criterion MISSING from a full replacement keeps its verdict', () => {
    const previous = [
      criterion('npm test passes', { status: 'passed', evidence: '212 green' }),
      criterion('README documents it'),
    ];
    // A table that is ONE ROW SHORTER, which is the commonest shape of omission.
    const result = normalizeAcceptance([criterion('README documents it')], previous, ON);
    expect(result.items).toHaveLength(2);
    const kept = result.items.find((item) => item.content === 'npm test passes');
    expect(kept?.status).toBe('passed');
    expect(kept?.evidence).toBe('212 green');
    // ...and the restored row is at the TAIL, so a cap takes it first (AC-5d).
    expect(result.items[1]!.content).toBe('npm test passes');
  });

  it('AC-5c: an UNCHECKED criterion may be dropped by a re-plan, silently', () => {
    const previous = [criterion('a'), criterion('b')];
    const result = normalizeAcceptance([criterion('a')], previous, ON);
    expect(result.items.map((item) => item.content)).toEqual(['a']);
    expect(result.repairs).toEqual([]);
  });

  it('AC-5d: restored rows sit at the tail, so the cap takes them first', () => {
    const previous = [
      criterion('kept-1', { status: 'passed', evidence: 'x' }),
      criterion('kept-2', { status: 'passed', evidence: 'y' }),
    ];
    const fresh = Array.from({ length: ACCEPT_LIMITS.maxItems }, (_, i) => criterion(`new-${i}`));
    const result = normalizeAcceptance(fresh, previous, ON);
    expect(result.items).toHaveLength(ACCEPT_LIMITS.maxItems);
    expect(result.items.some((item) => item.content.startsWith('kept-'))).toBe(false);
    expect(result.repairs.join(' ')).toContain('dropped (maximum');
  });

  it('AC-6: reopen: true is the only door back to unchecked, and it drops the evidence', () => {
    const previous = [criterion('npm test passes', { status: 'passed', evidence: '212 green' })];
    const result = normalizeAcceptance(
      [{ ...criterion('npm test passes', { status: 'pending' }), reopen: true }],
      previous,
      ON,
    );
    expect(result.items[0]!.status).toBe('pending');
    expect(result.items[0]!.evidence).toBe('');
    expect(result.repairs).toEqual([]);
  });

  it('AC-7: one changed character is a NEW criterion; the old verdict is NOT carried over', () => {
    const previous = [criterion('npm test passes', { status: 'passed', evidence: '212 green' })];
    const result = normalizeAcceptance([criterion('npm test passes.')], previous, ON);
    const fresh = result.items.find((item) => item.content === 'npm test passes.');
    expect(fresh?.status).toBe('pending');
    expect(result.repairs.join(' ')).not.toContain('kept its earlier verdict');
    // AND THE OLD ROW COMES BACK WITH ITS EVIDENCE: "改一个字" reads as a re-plan to
    // the model but is indistinguishable from a dropped row on the wire, and D-4
    // resolves that ambiguity in favour of never losing a verdict silently. The model
    // can drop it deliberately with `acceptance: []` (AC-8) or re-check it with
    // `reopen: true` (AC-6).
    const kept = result.items.find((item) => item.content === 'npm test passes');
    expect(kept?.status).toBe('passed');
    expect(kept?.evidence).toBe('212 green');
  });

  it('AC-8: an ABSENT key keeps the table while an explicit [] clears it', () => {
    const previous = [criterion('kept', { status: 'passed', evidence: 'saw it' })];
    expect(normalizeAcceptance(undefined, previous, ON).items).toEqual(previous);
    expect(normalizeAcceptance([], previous, ON).items).toEqual([]);
  });

  it('AC-8 (order): `enabled: false` short-circuits BEFORE the keep-previous rule', () => {
    // The P0-2 failure mode: with the order reversed, turning the capability off left
    // the table alive and `/todo acceptance off` looked like it did nothing.
    const previous = [criterion('kept', { status: 'passed', evidence: 'saw it' })];
    expect(normalizeAcceptance(undefined, previous, OFF).items).toEqual([]);
    expect(normalizeAcceptance([criterion('x')], previous, OFF).items).toEqual([]);
    expect(normalizeAcceptance(undefined, previous, OFF).repairs).toEqual([]);
  });

  it('AC-9: thirteen criteria keep twelve, and blanks are dropped BEFORE the cap', () => {
    const many = Array.from({ length: 13 }, (_, i) => criterion(`c${i}`));
    const capped = normalizeAcceptance(many, [], ON);
    expect(capped.items).toHaveLength(ACCEPT_LIMITS.maxItems);
    expect(capped.repairs.join(' ')).toContain(
      `the last 1 were dropped (maximum ${ACCEPT_LIMITS.maxItems})`,
    );

    const withBlank = [criterion('   '), ...Array.from({ length: 12 }, (_, i) => criterion(`c${i}`))];
    expect(normalizeAcceptance(withBlank, [], ON).items).toHaveLength(ACCEPT_LIMITS.maxItems);
  });

  it('AC-43: `in_progress` from the model is downgraded to pending, with no note', () => {
    // The store owns that state (§6.2.3 step 6); the model's copy is not a claim.
    const result = normalizeAcceptance([criterion('a', { status: 'in_progress' })], [], ON);
    expect(result.items[0]!.status).toBe('pending');
    expect(result.repairs).toEqual([]);
  });

  it('clamps every field and drops entries that are not objects', () => {
    const result = normalizeAcceptance(
      [
        'nope',
        {
          content: 'x'.repeat(ACCEPT_LIMITS.contentChars + 40),
          check: 'y'.repeat(ACCEPT_LIMITS.checkChars + 40),
          evidence: 'z'.repeat(ACCEPT_LIMITS.evidenceChars + 40),
          status: 'passed',
        },
      ],
      [],
      ON,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.content).toHaveLength(ACCEPT_LIMITS.contentChars);
    expect(result.items[0]!.check).toHaveLength(ACCEPT_LIMITS.checkChars);
    expect(result.items[0]!.evidence).toHaveLength(ACCEPT_LIMITS.evidenceChars);
    expect(result.repairs.join(' ')).toContain('1 criterion was dropped');
  });
});
