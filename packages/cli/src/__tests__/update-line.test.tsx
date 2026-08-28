/**
 * `UpdateLine` — every phase, both glyph tiers, both width tiers
 * (cli-auto-update §6.2 / §8.1).
 *
 * TWO PROPERTIES CARRY THIS FILE, and neither is about wording.
 *
 * (1) IT NEVER RETURNS `null` (AC-25 / C-15 / P0-1). `BottomStatusRow` decides
 * presence with `if (update)`, which tests a REACT ELEMENT — truthy however it
 * renders — so a component that rendered nothing would give the row ZERO rows
 * and silently unbalance the frame budget. A guard satisfied by a component that
 * renders nothing is no guard at all, which is why the assertion is on the
 * rendered FRAME rather than on the return value.
 *
 * (2) THE ASCII TIER IS ASCII (AC-18). `glyphs.test.ts`'s static scan covers the
 * SOURCE; this covers the OUTPUT, which is the thing a legacy `cmd.exe` actually
 * shows. The two are different claims: a source file free of non-ASCII literals
 * still renders mojibake if it reads the wrong tier.
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { UpdateLine } from '../ui/UpdateLine.js';
import { getTheme } from '../ui/theme.js';
import { UPDATE_LIMITS } from '../update/limits.js';
import { shouldRenderUpdateLine } from '../update/types.js';
import type { TermCapabilities } from '../ui/capabilities.js';
import type { UpdatePhase, UpdateReason, UpdateSnapshot } from '../update/types.js';

const UNICODE: TermCapabilities = { colorLevel: 3, unicode: true };
const ASCII: TermCapabilities = { colorLevel: 0, unicode: false };

function snap(over: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    phase: 'available',
    currentVersion: '0.5.9',
    latestVersion: '0.6.0',
    source: 'npm-global',
    advice: 'npm i -g @aragon-agent/cli',
    nextCheckAt: null,
    consecutiveFailures: 0,
    ...over,
  };
}

function frameOf(
  snapshot: UpdateSnapshot,
  caps: TermCapabilities = UNICODE,
  compact = false,
): string {
  const { lastFrame, unmount } = render(
    <UpdateLine
      snapshot={snapshot}
      compact={compact}
      theme={getTheme('cool', caps)}
      caps={caps}
    />,
  );
  const frame = stripAnsi(lastFrame() ?? '');
  unmount();
  return frame;
}

const ALL_PHASES: UpdatePhase[] = [
  'idle',
  'checking',
  'available',
  'installing',
  'ready',
  'failed',
];

describe('AC-25: never null, always exactly one row', () => {
  it('RETURNS AN ELEMENT for every phase, in both tiers (IF-5)', () => {
    // ASSERTED ON THE RETURN VALUE, NOT ON THE FRAME. §8.2 proposes
    // `expect(render(...).lastFrame()).not.toBe('')`, but that assertion cannot
    // hold and cannot discriminate: Ink trims trailing whitespace, so the
    // legitimately BLANK one-row element this component returns for `idle` and
    // a component that returned `null` both render as `''`. The property the
    // whole invariant is about is whether a React element comes back at all, so
    // that is what this checks — and the compiler enforces the same thing
    // statically through the `React.ReactElement` return type.
    for (const phase of ALL_PHASES) {
      for (const caps of [UNICODE, ASCII]) {
        for (const compact of [false, true]) {
          const label = `${phase}/${caps.unicode ? 'unicode' : 'ascii'}/${compact}`;
          const element = UpdateLine({
            snapshot: snap({ phase, consecutiveFailures: 3 }),
            compact,
            theme: getTheme('cool', caps),
            caps,
          });
          expect(element, label).not.toBeNull();
          expect(React.isValidElement(element), label).toBe(true);
        }
      }
    }
  });

  it('occupies exactly one row for every phase, in both tiers', () => {
    for (const phase of ALL_PHASES) {
      for (const caps of [UNICODE, ASCII]) {
        for (const compact of [false, true]) {
          const label = `${phase}/${caps.unicode ? 'unicode' : 'ascii'}/${compact}`;
          const frame = frameOf(snap({ phase, consecutiveFailures: 3 }), caps, compact);
          expect(frame.split('\n'), label).toHaveLength(1);
        }
      }
    }
  });

  it('renders a blank row for the phases the caller never mounts it in', () => {
    // `idle` / `checking` are gated out by `shouldRenderUpdateLine`; if the
    // component is ever mounted there anyway it must still be ONE row and say
    // nothing — the blank-row discipline `ToastStack` applies to its own.
    for (const phase of ['idle', 'checking'] as UpdatePhase[]) {
      expect(frameOf(snap({ phase })).trim()).toBe('');
    }
  });
});

describe('the lines (§6.2)', () => {
  it('available: version, then the command for THIS manager', () => {
    const wide = frameOf(snap());
    expect(wide).toContain('0.6.0 available');
    expect(wide).toContain('npm i -g @aragon-agent/cli');
    expect(wide).toContain('↑'); // arrowUp
    // Narrow drops everything but the number.
    const narrow = frameOf(snap(), UNICODE, true);
    expect(narrow).toContain('0.6.0');
    expect(narrow).not.toContain('npm i -g');
  });

  it('available for another manager carries ITS command, never npm', () => {
    const frame = frameOf(snap({ source: 'pnpm', advice: 'pnpm add -g @aragon-agent/cli' }));
    expect(frame).toContain('pnpm add -g @aragon-agent/cli');
    expect(frame).not.toContain('npm i -g');
  });

  it('installing: the ellipsis comes from pickGlyphs, never a literal', () => {
    // `ActivityLine.tsx` is the precedent for routing even the ellipsis through
    // the glyph table; a literal `...` is mojibake-safe but tier-inconsistent.
    expect(frameOf(snap({ phase: 'installing' }))).toContain('updating to 0.6.0…');
    expect(frameOf(snap({ phase: 'installing' }), ASCII)).toContain('updating to 0.6.0...');
  });

  it('ready: says what happened AND what the user must do', () => {
    const frame = frameOf(snap({ phase: 'ready' }));
    expect(frame).toContain('0.6.0 installed');
    // The whole of D-3: the human decides when to restart, not the updater.
    expect(frame).toContain('restart aragon to apply');
    expect(frameOf(snap({ phase: 'ready' }), UNICODE, true)).toContain('0.6.0 ready');
  });

  it('failed: one actionable clause, and only above the threshold', () => {
    const frame = frameOf(snap({ phase: 'failed', consecutiveFailures: 3 }));
    expect(frame).toContain('update failed');
    expect(frame).toContain('npm i -g @aragon-agent/cli');
  });

  it('node-too-old: names the range AND the running version', () => {
    const frame = frameOf(
      snap({
        reason: 'node-too-old' as UpdateReason,
        requiredNode: '>=20',
        runningNode: '18.19.0',
      }),
    );
    expect(frame).toContain('needs Node >=20');
    expect(frame).toContain('(running 18.19.0)');
    expect(frameOf(snap({ reason: 'node-too-old' }), UNICODE, true)).toContain(
      'needs newer Node',
    );
  });

  it('node-too-old degrades honestly when the numbers are absent', () => {
    // "Needs a newer Node" without saying which is weak, but inventing a range
    // would be worse.
    const frame = frameOf(snap({ reason: 'node-too-old' as UpdateReason }));
    expect(frame).toContain('needs a newer Node');
  });

  it('install-ineffective: names the real problem, which is the prefix (U-6)', () => {
    const frame = frameOf(snap({ reason: 'install-ineffective' as UpdateReason }));
    expect(frame).toContain('0.6.0 installed elsewhere');
    expect(frameOf(snap({ reason: 'install-ineffective' }), UNICODE, true)).toContain(
      'check npm prefix',
    );
  });
});

// ---------------------------------------------------------------------------
// The hardening round's four rows (cli-auto-update-hardening §8)
// ---------------------------------------------------------------------------

/** The four rows, as (label, snapshot patch, wide substring, compact text). */
const NEW_ROWS: Array<[string, Partial<UpdateSnapshot>, string, string]> = [
  [
    'blocked-by-os',
    { phase: 'failed', reason: 'blocked-by-os', consecutiveFailures: 1 },
    'update blocked',
    'update blocked',
  ],
  [
    'no-space',
    { phase: 'failed', reason: 'no-space', consecutiveFailures: 1 },
    'update failed',
    'no disk space',
  ],
  [
    'not-writable',
    { phase: 'failed', reason: 'not-writable', consecutiveFailures: 1 },
    'update needs write access',
    'update blocked',
  ],
  [
    'rolled back',
    { phase: 'idle', rolledBackFrom: '0.6.0', rolledBackTo: '0.5.9' },
    'rolled back to 0.5.9 after 0.6.0 failed to start',
    'rolled back',
  ],
];

describe('AC-46: the four new rows', () => {
  it('each renders EXACTLY ONE row in both width tiers and both glyph tiers', () => {
    for (const [label, patch] of NEW_ROWS) {
      for (const caps of [UNICODE, ASCII]) {
        for (const compact of [false, true]) {
          const where = `${label}/${caps.unicode ? 'unicode' : 'ascii'}/${compact}`;
          const frame = frameOf(snap(patch), caps, compact);
          expect(frame.split('\n'), where).toHaveLength(1);
          expect(frame.trim(), where).not.toBe('');
        }
      }
    }
  });

  it('says the right thing at each width', () => {
    for (const [label, patch, wide, compactText] of NEW_ROWS) {
      expect(frameOf(snap(patch)), `${label}/wide`).toContain(wide);
      expect(frameOf(snap(patch), UNICODE, true), `${label}/compact`).toContain(compactText);
    }
  });

  it('blocked-by-os names the OBSTACLE, not just the command (R-3 / §5.3.1)', () => {
    // The generic `npm i -g` from the same shell hits the same held handle and
    // fails identically, so the one visible failure would also be a WRONG
    // INSTRUCTION. The row has to say what to do about the handle first.
    const frame = frameOf(snap({ phase: 'failed', reason: 'blocked-by-os' }));
    expect(frame).toContain('close other aragon windows');
    expect(frame).toContain('npm i -g @aragon-agent/cli');
    // And it degrades rather than trailing a dangling "then:" with no command.
    const noAdvice = frameOf(
      snap({ phase: 'failed', reason: 'blocked-by-os', advice: undefined }),
    );
    expect(noAdvice).toContain('update blocked');
    expect(noAdvice).not.toContain('then:');
  });

  it('the rollback row never shows `latestVersion`, which may BE the bad release', () => {
    // `version` in the component is `latestVersion ?? currentVersion`, and after
    // a rollback the registry still offers the version we just escaped. Naming
    // it here would read as "we installed the thing that broke".
    const frame = frameOf(
      snap({ phase: 'idle', latestVersion: '0.6.0', rolledBackFrom: '0.6.0', rolledBackTo: '0.5.9' }),
    );
    expect(frame).toContain('rolled back to 0.5.9');
    expect(frame).not.toMatch(/rolled back to 0\.6\.0/);
  });

  it('falls back to `currentVersion` when only half the pair survived', () => {
    const frame = frameOf(snap({ phase: 'idle', rolledBackFrom: '0.6.0', rolledBackTo: undefined }));
    expect(frame).toContain('rolled back to 0.5.9');
  });

  it('contains no literal `+`, `~` or `...` and no non-ASCII in the ASCII tier', () => {
    for (const [label, patch] of NEW_ROWS) {
      for (const compact of [false, true]) {
        const frame = frameOf(snap(patch), ASCII, compact);
        expect(frame.match(/[^\x00-\x7f]/g), `${label}/${compact}`).toBeNull();
        expect(frame, `${label}/${compact}`).not.toMatch(/[+~]/);
      }
    }
  });
});

describe('AC-46b / AC-46c: presence is decided OUTSIDE `phase` (P0-1)', () => {
  it('AC-46b: `shouldRenderUpdateLine` is true at phase `idle` when a rollback is pending', () => {
    // THE ASSERTION AC-46 CANNOT MAKE. AC-46 feeds `UpdateLine` a snapshot BY
    // HAND, so it stays green on a design where the row never reaches the screen
    // at all — which is precisely what the first draft shipped: `idle` is
    // suppressed by the caller, `UpdateLine` has no `idle` branch, and nothing
    // ever wrote the field. Three independent suppressions, one green test. This
    // asserts on the predicate that actually decides presence.
    expect(shouldRenderUpdateLine(snap({ phase: 'idle', rolledBackFrom: '0.6.0' }))).toBe(true);
    expect(shouldRenderUpdateLine(snap({ phase: 'checking', rolledBackFrom: '0.6.0' }))).toBe(true);
    // And the complement: without the field, `idle` is silent as it always was.
    expect(shouldRenderUpdateLine(snap({ phase: 'idle', rolledBackFrom: '' }))).toBe(false);
    expect(shouldRenderUpdateLine(snap({ phase: 'idle' }))).toBe(false);
  });

  it('AC-46c: real news wins the row (§8 precedence, C-15)', () => {
    // The budget is ONE row. The rollback notice is the last test in the
    // predicate and is rendered only when the phase is otherwise silent, so a
    // machine with an update waiting may never see it — which is the correct
    // trade: the newer fact is the more actionable one, and the rollback is
    // still in `/update status` and in the log.
    const both = snap({ phase: 'available', rolledBackFrom: '0.6.0', rolledBackTo: '0.5.9' });
    expect(shouldRenderUpdateLine(both)).toBe(true);
    const frame = frameOf(both);
    expect(frame).toContain('0.6.0 available');
    expect(frame).not.toContain('rolled back');
  });
});

describe('AC-18: the ASCII tier emits no byte outside \\x00-\\x7f', () => {
  it('holds for every phase and reason, at both widths', () => {
    const reasons: (UpdateReason | undefined)[] = [
      undefined,
      'node-too-old',
      'install-ineffective',
      'not-writable',
      'source-ineligible',
      'blocked-by-os',
      'no-space',
    ];
    for (const phase of ALL_PHASES) {
      for (const reason of reasons) {
        for (const compact of [false, true]) {
          const frame = frameOf(
            snap({
              phase,
              consecutiveFailures: 3,
              ...(reason ? { reason } : {}),
              requiredNode: '>=20',
              runningNode: '18.19.0',
            }),
            ASCII,
            compact,
          );
          const offenders = frame.match(/[^\x00-\x7f]/g);
          expect(offenders, `${phase}/${reason}/${compact}`).toBeNull();
        }
      }
    }
  });
});

describe('the compact threshold is UPDATE_LIMITS-owned', () => {
  it('is deliberately not FAST_LIMITS.statusCompactCols', async () => {
    // `fast`'s 100 governs a multi-part chip competing with the context gauge
    // for the same row; this 60 governs one short clause that owns its row
    // outright. Two numbers about two different things — a later "unification"
    // would truncate this line early on a perfectly ordinary 80-column terminal.
    const { FAST_LIMITS } = await import('../fast/limits.js');
    expect(UPDATE_LIMITS.statusCompactCols).toBe(60);
    expect(UPDATE_LIMITS.statusCompactCols).not.toBe(FAST_LIMITS.statusCompactCols);
  });
});
