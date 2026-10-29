import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import * as layout from '../ui/layout/status-layout.js';
const base = {
 columns: 80, phase: 'thinking' as const, pendingCount: 3,
 context: { occupied: 2100, window: 128000, pct: 2, source: 'estimate' as const, deltaTokens: 0, windowKnown: true, windowOverridden: false },
 usageTotal: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40, costUsd: 0.0032 },
 thinkingLevel: 'xhigh', elapsedMs: 62000, tokPerSec: 12, speedKnown: true, spinner: '*',
};
it('keeps five core fields and measured separators from 40 to 200 columns', () => {
 expect(layout).toHaveProperty('planPrimaryStatusFields');
 for(let columns=40; columns<=200; columns++) {
 const plan=layout.planPrimaryStatusFields({...base, columns});
 expect(plan.fields.map(f=>f.id)).toEqual(['phase','context','thinking','speed','elapsed']);
 expect(plan.cells).toBe(stringWidth(plan.fields.map(f=>f.text).join(plan.separator)));
 expect(plan.separatorCells).toBe(stringWidth(plan.separator));
 expect(plan.cells).toBeLessThanOrEqual(columns-1);
 }
});
it('fits extreme values and preserves copy error plus force-stop', () => {
 // `copy-sent` IS A NOTIFICATION (defect 8/9): the phase word stays and the body
 // gets a field of its own, so its plan carries one more field than the action
 // kinds, which keep replacing the phase word.
 for(const kind of ['copy-error','copy-cleanup','copy-sent','exit'] as const) {
 const plan=layout.planPrimaryStatusFields({...base,columns:40,context:{...base.context,pct:1e300},tokPerSec:1e300,elapsedMs:1e300,
 feedback:{kind,text:'custom',level:'error'},escapeAction:'force-stop',activeTool:{name:'x'.repeat(1000),toolCallId:'t'}});
 const notification = kind === 'copy-sent';
 expect(plan.fields).toHaveLength(notification ? 6 : 5); expect(plan.cells).toBeLessThanOrEqual(39);
 expect(plan.fields[notification ? 2 : 1]!.text).toBe('C~>999%');
 if(notification) expect(plan.fields[1])
  .toMatchObject({ id: 'feedback', text: 'custom', tone: 'error' });
 if(kind==='copy-error'||kind==='copy-cleanup') expect(plan.fields[0]!.text).toMatch(/Err\/EscF|E\/F/);
 }
});

// DEFECT 8 + 9. The phase word used to BE the feedback label, so once a notice
// landed the row no longer answered "is the agent working?" - and the toast body
// itself only ever appeared on the second status row, behind Ctrl+G.
describe('a notification keeps the phase word and adds its body', () => {
 it('shows Idle and the toast text together', () => {
  const plan = layout.planPrimaryStatusFields({ ...base, columns: 100, phase: 'idle',
   speedKnown: false, feedback: { kind: 'notice', text: 'Theme set to light.', level: 'info' } });
  expect(plan.fields.map(f => f.id).slice(0, 2)).toEqual(['phase', 'feedback']);
  expect(plan.fields[0]!.text).toContain('Idle');
  expect(plan.fields[1]).toMatchObject({ text: 'Theme set to light.', tone: 'normal' });
  expect(plan.cells).toBeLessThanOrEqual(99);
 });
 it('keeps the phase word while a copy is reported and tones the body', () => {
  const plan = layout.planPrimaryStatusFields({ ...base, columns: 100, phase: 'idle',
   feedback: { kind: 'copied', text: 'Copied to clipboard.', level: 'info' } });
  expect(plan.fields[0]!.text).toContain('Idle');
  expect(plan.fields[1]!.id).toBe('feedback');
 });
 it('never lets the body displace the phase word, whatever the width', () => {
  for (let columns = 40; columns <= 200; columns += 1) {
   const plan = layout.planPrimaryStatusFields({ ...base, columns, phase: 'generating',
    feedback: { kind: 'notice', text: 'x'.repeat(200), level: 'warn' } });
   expect(plan.fields[0]!.id).toBe('phase');
   expect(plan.fields[0]!.text).not.toContain('Notice');
   expect(plan.cells).toBeLessThanOrEqual(columns - 1);
  }
 });
 it('clips a long body instead of pushing the row over budget', () => {
  const plan = layout.planPrimaryStatusFields({ ...base, columns: 200, phase: 'idle',
   feedback: { kind: 'notice', text: 'y'.repeat(300), level: 'info' } });
  const body = plan.fields[1]!;
  expect(body.id).toBe('feedback');
  expect(body.cells).toBeLessThanOrEqual(32);
 });
 it('drops the body before it would hide the phase word', () => {
  // 40 columns cannot hold the phase word plus a body; the ladder gives up the
  // BODY, never the word that says whether the agent is running.
  const plan = layout.planPrimaryStatusFields({ ...base, columns: 40, phase: 'generating',
   feedback: { kind: 'notice', text: 'A long confirmation message.', level: 'info' } });
  expect(plan.fields.some(f => f.id === 'feedback')).toBe(false);
  expect(plan.fields[0]!.id).toBe('phase');
 });
 it('still lets an ACTION kind take the phase slot', () => {
  const plan = layout.planPrimaryStatusFields({ ...base, columns: 100, phase: 'idle',
   feedback: { kind: 'exit', text: 'Press Ctrl+C again to exit', level: 'warn' } });
  expect(plan.fields.map(f => f.id)).not.toContain('feedback');
  expect(plan.fields[0]!.text).toMatch(/exit/i);
 });
});
it('rejects invalid contexts', () => {
 for(const key of ['occupied','window','pct','deltaTokens'] as const) for(const value of [NaN,Infinity,-1]) {
 expect(layout.planPrimaryStatusFields({...base,columns:40,context:{...base.context,[key]:value}}).fields[1]!.text).toBe('C?');
 }
 expect(layout.planPrimaryStatusFields({...base,columns:40,context:{...base.context,windowKnown:false}}).fields[1]!.text).toBe('C?');
});
it('shows off and unknown speed while preserving final elapsed', () => {
 expect(layout.planPrimaryStatusFields({...base,phase:'idle',columns:40,thinkingLevel:'off',speedKnown:false}).fields.map(f=>f.text))
 .toEqual(['* Idle','C~2%','Th:O','--t/s','1m02s']);
});
it('fits every phase and thinking code with maximal numeric formats', () => {
 for (const phase of ['idle','starting','waiting','thinking','generating','preparing-tool','tool'] as const) {
  for (const thinkingLevel of ['off','minimal','low','medium','high','xhigh','unknown']) {
   for (const feedback of [undefined, {kind:'copy-error' as const,text:'failure',level:'error' as const}]) {
    const plan=layout.planPrimaryStatusFields({...base,columns:40,phase,thinkingLevel,
     elapsedMs:Number.MAX_VALUE,tokPerSec:Number.MAX_VALUE,context:{...base.context,pct:Number.MAX_VALUE},
     feedback,escapeAction:'force-stop'});
    expect(plan.fields).toHaveLength(5);expect(plan.cells).toBeLessThanOrEqual(39);
    expect(plan.fields[1]!.text).toBe('C~>999%');expect(plan.fields[4]!.text).toBe('>999d');
   }
  }
 }
});
it('keeps copy error plus armed stop distinct from force stop and menu', () => {
 const feedback={kind:'copy-error' as const,text:'failed',level:'error' as const};
 expect(layout.planPrimaryStatusFields({...base,columns:40,feedback,interruptPhase:'armed',escapeAction:'confirm-stop'})
  .fields[0]!.text).toMatch(/Err\/EscS|E\/S/);
 expect(layout.planPrimaryStatusFields({...base,columns:40,feedback,interruptPhase:'stopping',escapeAction:'menu'})
  .fields[0]!.text).not.toMatch(/EscF|E\/F/);
});
it('sanitizes external tool names and never interprets control bytes', () => {
 const plan=layout.planPrimaryStatusFields({...base,columns:300,activeTool:{name:'\x1b[31mtool\nname\x00',toolCallId:'t'}});
 expect(plan.fields[0]!.text).toContain('tool name');
 expect(plan.fields[0]!.text).not.toMatch(/[\x00-\x1f]/);
});

describe('planPrimaryStatusFields mode word', () => {
  it('names both modes on the primary row right after the phase word', () => {
    for (const [mode, word] of [['build', 'BUILD'], ['plan', 'PLAN']] as const) {
      const plan = layout.planPrimaryStatusFields({ ...base, columns: 120, mode });
      expect(plan.fields.map(f => f.id)).toEqual(['phase', 'mode', 'context', 'thinking', 'speed', 'elapsed']);
      expect(plan.fields[1]).toMatchObject({ id: 'mode', text: word, tone: 'accent' });
    }
  });
  it('renders a deferred switch as CUR>PENDING and degrades to letters when tight', () => {
    const wide = layout.planPrimaryStatusFields({ ...base, columns: 120, mode: 'plan', pendingMode: 'build' });
    expect(wide.fields[1]!.text).toBe('PLAN>BUILD');
    const narrow = layout.planPrimaryStatusFields({ ...base, columns: 40, mode: 'plan', pendingMode: 'build',
      context: { ...base.context, pct: 1e300 }, tokPerSec: 1e300, elapsedMs: 1e300 });
    expect(narrow.fields[1]!.text).toBe('P>B');
  });
  it('keeps the mode word inside the budget in the maximal-value ladder', () => {
    for (let columns = 40; columns <= 200; columns += 1) {
      for (const mode of ['build', 'plan'] as const) {
        const plan = layout.planPrimaryStatusFields({ ...base, columns, mode,
          pendingMode: mode === 'plan' ? 'build' : 'plan',
          context: { ...base.context, pct: 1e300 }, tokPerSec: 1e300, elapsedMs: 1e300,
          feedback: { kind: 'copy-error', text: 'failure', level: 'error' }, escapeAction: 'force-stop' });
        expect(plan.cells).toBeLessThanOrEqual(columns - 1);
        expect(plan.fields.map(f => f.id)).toContain('mode');
      }
    }
  });
  it('omits the mode field entirely when the caller names no mode', () => {
    const plan = layout.planPrimaryStatusFields({ ...base, columns: 120 });
    expect(plan.fields.map(f => f.id)).toEqual(['phase', 'context', 'thinking', 'speed', 'elapsed']);
  });
});

// tui-session-id-resume 7.1 T-35 / T-36. The session-id chip is not a layer over
// this row: it is planned FIRST and then spent out of this budget, because the
// row is measured rather than laid out and anything overlapping it eats `phase`.
describe('reserveRight (tui-session-id-resume 3.10 / I-6)', () => {
  it('reserveRight shrinks the field budget', () => {
    for (const columns of [60, 80, 120]) {
      const full = layout.planPrimaryStatusFields({ ...base, columns });
      const reserved = layout.planPrimaryStatusFields({ ...base, columns, reserveRight: 12 });
      expect(reserved.cells).toBeLessThanOrEqual(full.cells);
      // ...and the reservation is what the planner actually honours.
      expect(reserved.cells).toBeLessThanOrEqual(columns - 1 - 12);
    }
  });

  it('an absent reserveRight is byte-identical to today', () => {
    // THE REGRESSION RED LINE (I-6): every existing caller passes no
    // `reserveRight`, and its plan must be deep-equal to the one it got before
    // the feature existed. `0` and `undefined` therefore mean the same thing.
    for (const columns of [40, 61, 80, 137]) {
      for (const extra of [{}, { mode: 'plan' }, { compacting: true }, { scrolledLines: 12 }]) {
        const withoutKey = layout.planPrimaryStatusFields({ ...base, columns, ...extra });
        const withZero = layout.planPrimaryStatusFields({ ...base, columns, ...extra, reserveRight: 0 });
        expect(withZero).toEqual(withoutKey);
      }
    }
  });

  it('a nonsense reservation cannot produce a negative budget', () => {
    for (const reserveRight of [-10, Number.NaN]) {
      const plan = layout.planPrimaryStatusFields({ ...base, columns: 80, reserveRight });
      expect(plan.cells).toBeGreaterThanOrEqual(0);
      expect(plan.cells).toBeLessThanOrEqual(79);
    }
  });
});

// CONTEXT-COMPACTION-NEVER-FIRES C. `selfDisabled` used to live only in
// `/compact status`, a command nobody types at the moment the gauge is stuck at
// 95% - which is exactly the moment the fact matters.
describe('the auto-paused suffix on the context gauge', () => {
  const paused = { ...base, context: { ...base.context, pct: 95 } };

  it('rides on the context field, because it explains that percentage', () => {
    const plan = layout.planPrimaryStatusFields({
      ...paused, columns: 120, compactionPaused: true,
    });
    // The `~` is the estimate mark the gauge already carries; the suffix goes last.
    expect(plan.fields.find((field) => field.id === 'context')!.text)
      .toBe('Context ~95% auto-paused');
  });

  it('abbreviates when the row is tight, and never displaces the phase word', () => {
    const plan = layout.planPrimaryStatusFields({ ...paused, columns: 40, compactionPaused: true });
    const context = plan.fields.find((field) => field.id === 'context')!.text;
    expect(context.startsWith('C') && context.endsWith('paused')).toBe(true);
    expect(plan.fields[0]!.id).toBe('phase');
    expect(plan.cells).toBeLessThanOrEqual(39);
  });

  it('is absent - byte for byte - when compaction has not paused', () => {
    for (const columns of [40, 61, 80, 137]) {
      const withoutKey = layout.planPrimaryStatusFields({ ...paused, columns });
      const withFalse = layout.planPrimaryStatusFields({
        ...paused, columns, compactionPaused: false,
      });
      expect(withFalse).toEqual(withoutKey);
      const contextText = withoutKey.fields.find((field) => field.id === 'context')!.text;
      expect(contextText).not.toContain('paused');
    }
  });
});

// team-command-forced-dispatch §3.8 / §5.4: the `Team N` chip.
//
// IT IS THE ONLY PERSISTENTLY VISIBLE SIGNAL that `/team` happened - the
// directive is one turn, the prompt block is invisible, and the panel only exists
// while a dispatch runs - so the assertion is not "it renders" but "it never
// disappears at any width, and never appears when the session is not armed".
describe('the forced-team chip (§3.8, matrix 31, AC-11)', () => {
  it('spells it out at every wide rung and abbreviates on a tight one', () => {
    const wide = layout.planPrimaryStatusFields({ ...base, columns: 120,
      mode: 'build', forcedTeam: { count: 4 } });
    const field = wide.fields.find((item) => item.id === 'forcedTeam')!;
    expect(field.text).toBe('Team 4');
    // `accent`, like the mode word: both describe a state the USER armed, and the
    // row's one always-on emphasis is already spent on that class of fact.
    expect(field.tone).toBe('accent');
    // Directly AFTER the mode field, so "build" and "Team 4" read as one phrase.
    const ids = wide.fields.map((item) => item.id);
    expect(ids.indexOf('forcedTeam')).toBe(ids.indexOf('mode') + 1);

    const tight = layout.planPrimaryStatusFields({ ...base, columns: 40, mode: 'plan',
      pendingMode: 'build', forcedTeam: { count: 4 },
      feedback: { kind: 'notice', text: 'a fairly long notice body here', level: 'warn' } });
    expect(tight.fields.find((item) => item.id === 'forcedTeam')!.text).toBe('T4');
  });

  it('survives every width from 40 to 200 columns', () => {
    for (let columns = 40; columns <= 200; columns += 1) {
      const plan = layout.planPrimaryStatusFields({ ...base, columns,
        forcedTeam: { count: 10 } });
      const field = plan.fields.find((item) => item.id === 'forcedTeam');
      // NEVER DROPPED. A chip that vanished on a narrow terminal is
      // indistinguishable from a disarmed session, which is the one question it
      // exists to answer (R-8).
      expect(field).toBeDefined();
      expect(['Team 10', 'T10']).toContain(field!.text);
      expect(plan.cells).toBeLessThanOrEqual(columns - 1);
      expect(plan.fields[0]!.id).toBe('phase');
    }
  });

  it('is absent - and the plan is byte-identical - when not armed', () => {
    for (const columns of [40, 61, 80, 137]) {
      const withoutKey = layout.planPrimaryStatusFields({ ...base, columns });
      const withUndefined = layout.planPrimaryStatusFields({
        ...base, columns, forcedTeam: undefined,
      });
      expect(withUndefined).toEqual(withoutKey);
      expect(withoutKey.fields.map((item) => item.id)).not.toContain('forcedTeam');
    }
  });

  it('keeps the mode word when both are present', () => {
    const plan = layout.planPrimaryStatusFields({ ...base, columns: 200,
      mode: 'plan', pendingMode: null, forcedTeam: { count: 2 } });
    const ids = plan.fields.map((item) => item.id);
    expect(ids).toContain('mode');
    expect(ids).toContain('forcedTeam');
    expect(plan.fields.find((item) => item.id === 'mode')!.text).toContain('PLAN');
  });
});
