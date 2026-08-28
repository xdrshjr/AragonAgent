import { describe, expect, it } from 'vitest';
import { textResult, type AgentTool, type ToolResult } from '@aragon-agent/core';
import { TeamBus, renderMailBlock } from '../team/bus.js';
import { makeTeamSend, makeTeamWait, withMailboxTail } from '../team/comm-tools.js';
import { TEAM_LIMITS } from '../team/limits.js';

const ctx = {};

function text(result: ToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

/** A clock we control, so the 15 s interval rule is testable without waiting. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const echoTool: AgentTool = {
  name: 'read_file',
  label: 'read',
  description: 'read',
  parameters: { type: 'object', properties: {} },
  execute: async () => textResult('file contents'),
};

describe('TeamBus quotas and intervals (the "bu neng tai pin fan" clause)', () => {
  it('EVERY refusal is a NON-ERROR result (D-7)', async () => {
    // An `errorResult` reads to a model as a malfunction and invites an
    // immediate retry — precisely the behaviour the limits exist to prevent.
    const c = clock();
    const bus = new TeamBus(['a1', 'a2'], { now: c.now });
    const send = makeTeamSend(bus, 'a1');

    const first = await send.execute('1', { to: 'a2', subject: 's', body: 'b' }, ctx);
    expect(first.isError).toBeFalsy();

    const tooSoon = await send.execute('2', { to: 'a2', subject: 's', body: 'b' }, ctx);
    expect(tooSoon.isError).toBeFalsy();
    expect(text(tooSoon)).toContain('Not sent');

    const unknown = await send.execute('3', { to: 'a9', subject: 's', body: 'b' }, ctx);
    expect(unknown.isError).toBeFalsy();
    expect(text(unknown)).toContain('no subagent labelled "a9"');
  });

  it('refuses a second send inside the interval and names the seconds left (AC-6)', async () => {
    const c = clock();
    const bus = new TeamBus(['a1', 'a2'], { now: c.now });
    const send = makeTeamSend(bus, 'a1');

    await send.execute('1', { to: 'a2', subject: 's', body: 'b' }, ctx);
    c.advance(6_000);
    const blocked = await send.execute('2', { to: 'a2', subject: 's', body: 'b' }, ctx);
    expect(text(blocked)).toContain('Try again in 9s');
    // ...and it was NOT delivered.
    expect(bus.drain('a2')).toHaveLength(1);

    c.advance(TEAM_LIMITS.minSendIntervalMs);
    const allowed = await send.execute('3', { to: 'a2', subject: 's2', body: 'b' }, ctx);
    expect(text(allowed)).toContain('Delivered to a2');
  });

  it('refuses the 7th message from one child and says the quota is spent (AC-6)', async () => {
    const c = clock();
    const bus = new TeamBus(['a1', 'a2'], { now: c.now });
    const send = makeTeamSend(bus, 'a1');

    for (let i = 0; i < TEAM_LIMITS.messagesPerAgent; i += 1) {
      const r = await send.execute(String(i), { to: 'a2', subject: `s${i}`, body: 'b' }, ctx);
      expect(text(r)).toContain('Delivered');
      c.advance(TEAM_LIMITS.minSendIntervalMs);
    }
    const seventh = await send.execute('x', { to: 'a2', subject: 's', body: 'b' }, ctx);
    expect(seventh.isError).toBeFalsy();
    expect(text(seventh)).toContain('message quota spent (6/6)');
    expect(bus.drain('a2')).toHaveLength(TEAM_LIMITS.messagesPerAgent);
  });

  it('a broadcast costs two quota units and reaches everyone but the sender', () => {
    const c = clock();
    const bus = new TeamBus(['a1', 'a2', 'a3'], { now: c.now });
    const verdict = bus.send('a1', 'all', 'heads up', 'routes.ts is mine');
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.spent).toBe(TEAM_LIMITS.broadcastCost);
      expect(verdict.delivered).toEqual(['a2', 'a3', 'lead']);
      expect(verdict.remaining).toBe(TEAM_LIMITS.messagesPerAgent - TEAM_LIMITS.broadcastCost);
    }
    expect(bus.sentCount('a1')).toBe(TEAM_LIMITS.broadcastCost);
    expect(bus.leadMail()).toHaveLength(1);
  });

  it('stops everyone once the dispatch total is spent', () => {
    const c = clock();
    const labels = Array.from({ length: 6 }, (_, i) => `a${i}`);
    const bus = new TeamBus(labels, { now: c.now });
    let sent = 0;
    // Six children x six messages each would be 36; the dispatch cap is 24.
    for (let round = 0; round < TEAM_LIMITS.messagesPerAgent; round += 1) {
      for (const from of labels) {
        if (bus.send(from, 'lead', `s${round}`, 'b').ok) sent += 1;
      }
      c.advance(TEAM_LIMITS.minSendIntervalMs);
    }
    expect(sent).toBe(TEAM_LIMITS.messagesPerDispatch);
    expect(bus.messageCount()).toBe(TEAM_LIMITS.messagesPerDispatch);
  });

  it('clamps an over-long subject and body instead of refusing the message', () => {
    const bus = new TeamBus(['a1', 'a2']);
    bus.send('a1', 'a2', 'S'.repeat(500), 'B'.repeat(5000));
    const [message] = bus.drain('a2');
    expect(message!.subject).toHaveLength(TEAM_LIMITS.subjectChars);
    expect(message!.body).toHaveLength(TEAM_LIMITS.bodyChars);
  });

  it('refuses a message addressed to the sender itself', () => {
    const bus = new TeamBus(['a1', 'a2']);
    const verdict = bus.send('a1', 'a1', 's', 'b');
    expect(verdict.ok).toBe(false);
  });
});

describe('delivery: piggy-back, not interrupt (D-4)', () => {
  it('appends mail to the recipient\'s NEXT tool result inside a <team_mail> block (AC-5)', async () => {
    // `Agent.steer()` is NOT used for this, and that is the central design
    // choice of the bus: the core loop cancels every remaining tool call in a
    // batch when steering arrives, so a chatty peer would silently cancel a
    // colleague's work as a side effect of saying hello.
    const bus = new TeamBus(['a1', 'a2']);
    const wrapped = withMailboxTail(echoTool, bus, 'a2');

    const before = await wrapped.execute('1', {}, ctx);
    expect(text(before)).not.toContain('<team_mail>');

    bus.send('a1', 'a2', 'auth uses a second session store', 'see src/auth/session.ts');
    const after = await wrapped.execute('2', {}, ctx);
    expect(text(after)).toContain('file contents');
    expect(text(after)).toContain('<team_mail>');
    expect(text(after)).toContain('from a1: auth uses a second session store');

    // Drained, so it is delivered exactly once.
    expect(text(await wrapped.execute('3', {}, ctx))).not.toContain('<team_mail>');
  });

  it('delivers even when the wrapped tool failed', async () => {
    // Holding mail back until a successful call would make delivery depend on
    // whether the child happened to be doing well.
    const failing: AgentTool = {
      ...echoTool,
      execute: async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    };
    const bus = new TeamBus(['a1', 'a2']);
    bus.send('a1', 'a2', 'subject', 'body');
    const result = await withMailboxTail(failing, bus, 'a2').execute('1', {}, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('<team_mail>');
  });
});

describe('team_wait', () => {
  const deps = { getAgent: () => null, maxWaitMs: 120_000 };

  it('resolves as soon as a matching message arrives', async () => {
    const bus = new TeamBus(['a1', 'a2']);
    const wait = makeTeamWait(bus, 'a2', deps);
    const pending = wait.execute('1', { timeoutSeconds: 30 }, ctx);
    bus.send('a1', 'a2', 'ready', 'the migration is applied');
    expect(text(await pending)).toContain('from a1: ready');
  });

  it('takes a message already queued without waiting', async () => {
    const bus = new TeamBus(['a1', 'a2']);
    bus.send('a1', 'a2', 'early', 'body');
    expect(text(await makeTeamWait(bus, 'a2', deps).execute('1', {}, ctx))).toContain('early');
  });

  it('honours `from` and leaves a non-matching message in the mailbox', async () => {
    const bus = new TeamBus(['a1', 'a2', 'a3']);
    const wait = makeTeamWait(bus, 'a3', deps);
    const pending = wait.execute('1', { from: 'a2', timeoutSeconds: 5 }, ctx);
    bus.send('a1', 'a3', 'not you', 'body');
    bus.send('a2', 'a3', 'you', 'body');
    expect(text(await pending)).toContain('from a2: you');
    expect(bus.drain('a3').map((m) => m.from)).toEqual(['a1']);
  });

  it('times out with actionable guidance rather than an error', async () => {
    const bus = new TeamBus(['a1', 'a2']);
    // Clamped up to the 5 s floor, then bounded by `maxWaitMs` — 60 ms here, so
    // this is a real timer and still fast.
    const wait = makeTeamWait(bus, 'a2', { getAgent: () => null, maxWaitMs: 60 });
    const result = await wait.execute('1', { timeoutSeconds: 1 }, ctx);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('Continue without it');
  });

  it('settles on abort, and pauses/resumes the CHILD\'s watchdog around the wait', async () => {
    // A deliberate wait is not a wedged agent (I-3, one level down): the child
    // emits nothing while it is blocked here, so its own idle watchdog would
    // otherwise abort it mid-wait.
    const events: string[] = [];
    const agent = {
      pauseIdleWatchdog: () => events.push('pause'),
      resumeIdleWatchdog: () => events.push('resume'),
    };
    const bus = new TeamBus(['a1', 'a2']);
    const controller = new AbortController();
    const wait = makeTeamWait(bus, 'a2', { getAgent: () => agent, maxWaitMs: 120_000 });
    const pending = wait.execute('1', { timeoutSeconds: 60 }, { signal: controller.signal });
    controller.abort();
    await pending;
    expect(events).toEqual(['pause', 'resume']);
  });

  it('cancelAllWaits settles everything outstanding', async () => {
    const bus = new TeamBus(['a1', 'a2']);
    const wait = makeTeamWait(bus, 'a2', { getAgent: () => null, maxWaitMs: 120_000 });
    const pending = wait.execute('1', { timeoutSeconds: 120 }, ctx);
    bus.cancelAllWaits();
    expect(text(await pending)).toContain('Continue without it');
  });
});

// ---------------------------------------------------------------------------
// F-3 — waits nobody can answer
// ---------------------------------------------------------------------------

/**
 * A `canSend` shaped exactly like the one `TeamRuntime` installs: NEGATIVE, over
 * TERMINAL PHASES ONLY, permitting any label it has never heard of.
 *
 * The map is mutated between calls on purpose - the predicate has to be
 * consulted at check time rather than captured, because F-4 replaces a handle
 * mid-dispatch.
 */
function phaseOracle(phases: Map<string, string>): (label: string) => boolean {
  return (label) => {
    const phase = phases.get(label);
    if (phase === undefined) return true;
    return phase !== 'done' && phase !== 'failed' && phase !== 'aborted';
  };
}

/** Park a waiter on the bus so `checkWaitable` can see its deadline. */
function park(bus: TeamBus, key: string, timeoutMs: number, from?: string): void {
  void bus.wait(key, { ...(from ? { from } : {}), timeoutMs });
}

describe('checkWaitable: a wait nobody can answer is refused, not slept through', () => {
  it('AC-18a: the deadline comparison uses the BUS clock, not Date.now (P1-1)', async () => {
    // RUN THIS BEFORE AC-19 AND AC-20. Those two are the only criteria in the
    // round that depend on the shared clock, and under a caller-computed
    // deadline they would compare a real timestamp with a fake one and assert
    // whatever the wall clock happened to make true that second.
    const c = clock(0); // deliberately nowhere near Date.now()
    const bus = new TeamBus(['a1', 'a2'], { now: c.now });

    park(bus, 'a2', 30_000, 'a1');
    // Equal deadlines: nothing can release `a2` before `a1`'s own deadline.
    expect(bus.checkWaitable('a1', { from: 'a2', timeoutMs: 30_000 })?.reason).toBe('all_blocked');
    // A shorter deadline on the peer: it wakes first and may then send.
    expect(bus.checkWaitable('a1', { from: 'a2', timeoutMs: 60_000 })).toBeNull();
    bus.cancelAllWaits();
  });

  it('AC-18: a peer that cannot send any more is refused immediately, with no clock advance', async () => {
    const c = clock();
    const phases = new Map([['a2', 'done']]);
    const bus = new TeamBus(['a1', 'a2'], { now: c.now, canSend: phaseOracle(phases) });
    const before = c.now();

    const result = await makeTeamWait(bus, 'a1', { getAgent: () => null, maxWaitMs: 120_000 })
      .execute('1', { from: 'a2', timeoutSeconds: 120 }, ctx);

    expect(c.now()).toBe(before); // "immediately" means the clock never moved
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('already finished');
    expect(text(result)).not.toContain('No message arrived');
  });

  it('AC-19: a mutual wait with EQUAL deadlines refuses the second waiter', () => {
    const c = clock();
    const bus = new TeamBus(['a1', 'a2'], { now: c.now });
    park(bus, 'a2', 60_000, 'a1');
    const refusal = bus.checkWaitable('a1', { from: 'a2', timeoutMs: 60_000 });
    expect(refusal).toEqual({ reason: 'all_blocked', who: ['a2'] });
    bus.cancelAllWaits();
  });

  it('AC-20: the LONGER waiter is permitted, because the shorter one wakes first', () => {
    // `b` is blocked for 30 s; `a` then wants 120 s. At t=30 `b` times out,
    // returns to its loop and may well send - comfortably inside `a`'s deadline.
    // A cycle detector that ignores deadlines refuses `a` here, which is the
    // failure this criterion exists to catch.
    const c = clock();
    const bus = new TeamBus(['a1', 'a2'], { now: c.now });
    park(bus, 'a2', 30_000, 'a1');
    expect(bus.checkWaitable('a1', { from: 'a2', timeoutMs: 120_000 })).toBeNull();
    bus.cancelAllWaits();
  });

  it('AC-20-inv: ...and the SHORTER waiter is refused, so the asymmetry is deliberate', () => {
    // The converse of AC-20. In a two-child dispatch nothing can release `a1`
    // inside 30 s, so refusing `a2` is correct - and v1 of this spec asserted the
    // opposite, which would have had an implementer weaken a correct rule to
    // make a wrong test pass (P1-9).
    const c = clock();
    const bus = new TeamBus(['a1', 'a2'], { now: c.now });
    park(bus, 'a1', 120_000, 'a2');
    expect(bus.checkWaitable('a2', { from: 'a1', timeoutMs: 30_000 })?.reason).toBe('all_blocked');
    bus.cancelAllWaits();
  });

  it('AC-20a: a peer a THIRD PARTY could release is not refused (the fixpoint)', () => {
    // `a1` waits on `a2`; `a2` is already waiting on `a3` with an equal
    // deadline; `a3` is running and unblocked. `a3` can message `a2`, `a2` can
    // then message `a1`, and all of it fits inside `a1`'s deadline. A
    // deadline-only rule sees `a2` blocked past `a1`'s deadline and refuses.
    const c = clock();
    const bus = new TeamBus(['a1', 'a2', 'a3'], { now: c.now });
    park(bus, 'a2', 60_000, 'a3');
    expect(bus.checkWaitable('a1', { from: 'a2', timeoutMs: 60_000 })).toBeNull();
    bus.cancelAllWaits();
  });

  it('AC-20a: ...and the same chain IS refused once the third party has finished', () => {
    // The fixpoint has to close in both directions, or it is just a permit-all.
    const c = clock();
    const phases = new Map([['a3', 'done']]);
    const bus = new TeamBus(['a1', 'a2', 'a3'], { now: c.now, canSend: phaseOracle(phases) });
    park(bus, 'a2', 60_000, 'a3');
    expect(bus.checkWaitable('a1', { from: 'a2', timeoutMs: 60_000 })?.reason).toBe('all_blocked');
    bus.cancelAllWaits();
  });

  it('AC-20b: a QUEUED peer counts as able to send (P0-2)', () => {
    // At the SHIPPED DEFAULTS (`maxConcurrent: 3`, `maxSubagents: 5`) children 4
    // and 5 sit in `queued` for the first part of every five-way dispatch, so a
    // `canSend` written as "the phase is running" refuses this wait as
    // "a5 already finished" on the default configuration.
    const c = clock();
    const phases = new Map([
      ['a1', 'thinking'],
      ['a2', 'thinking'],
      ['a3', 'thinking'],
      ['a4', 'queued'],
      ['a5', 'queued'],
    ]);
    const labels = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const bus = new TeamBus(labels, { now: c.now, canSend: phaseOracle(phases) });
    expect(bus.checkWaitable('a1', { from: 'a5', timeoutMs: 60_000 })).toBeNull();
  });

  it('AC-20c: the predicate is consulted at CHECK time, never captured', () => {
    // F-4 replaces `handles[index]` mid-dispatch, so a captured array or a
    // captured handle would answer for the discarded child.
    const c = clock();
    const phases = new Map([['a2', 'starting']]);
    const bus = new TeamBus(['a1', 'a2'], { now: c.now, canSend: phaseOracle(phases) });
    expect(bus.checkWaitable('a1', { from: 'a2', timeoutMs: 60_000 })).toBeNull();
    phases.set('a2', 'failed');
    expect(bus.checkWaitable('a1', { from: 'a2', timeoutMs: 60_000 })?.reason).toBe('all_finished');
  });

  it('AC-21: a queued message means the wait is never pointless, however dead the peers', () => {
    const c = clock();
    const phases = new Map([['a1', 'done']]);
    const bus = new TeamBus(['a1', 'a2'], { now: c.now, canSend: phaseOracle(phases) });
    bus.send('a1', 'a2', 'here it is', 'body');
    expect(bus.checkWaitable('a2', { timeoutMs: 60_000 })).toBeNull();
    expect(bus.checkWaitable('a2', { from: 'a1', timeoutMs: 60_000 })).toBeNull();
  });

  it('AC-21a: `from` is matched case-insensitively AND consistently (P1-3)', async () => {
    // The second half is the one that matters. v1 accepted `A2` at the gate and
    // then handed `wait()` a string its own delivery filter could never match,
    // so F-3 declined to fire on exactly the case it exists for.
    const bus = new TeamBus(['a1', 'a2']);
    const wait = makeTeamWait(bus, 'a1', { getAgent: () => null, maxWaitMs: 120_000 });
    const pending = wait.execute('1', { from: 'A2', timeoutSeconds: 30 }, ctx);
    bus.send('a2', 'a1', 'canonical', 'body');
    expect(text(await pending)).toContain('from a2: canonical');
  });

  it('AC-22: a single-child dispatch refuses with `no_peers`', async () => {
    const bus = new TeamBus(['a1']);
    const result = await makeTeamWait(bus, 'a1', { getAgent: () => null, maxWaitMs: 120_000 })
      .execute('1', {}, ctx);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('only subagent in this dispatch');
  });

  it('AC-22a: `unknown_sender` is its own reason, with the labels that DO exist (P1-2)', async () => {
    // Three distinct situations, none of which is "you have no teammates" - and
    // in a five-child dispatch that sentence is simply false. This is the only
    // one of the four refusals the child can act on IN THIS TURN.
    const labels = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const bus = new TeamBus(labels);
    const wait = makeTeamWait(bus, 'a1', { getAgent: () => null, maxWaitMs: 120_000 });

    for (const asked of ['a9', 'lead', 'a1']) {
      const result = await wait.execute('1', { from: asked, timeoutSeconds: 30 }, ctx);
      expect(result.isError, asked).toBeFalsy();
      expect(text(result), asked).toContain(`Nobody here is called "${asked}"`);
      expect(text(result), asked).not.toContain('only subagent in this dispatch');
      expect(text(result), asked).toContain('a2');
    }
  });

  it('caps a long label list rather than emitting a 200-character refusal', async () => {
    const labels = Array.from({ length: 10 }, (_, i) => `agent${i}`);
    const bus = new TeamBus(labels);
    const result = await makeTeamWait(bus, 'agent0', { getAgent: () => null, maxWaitMs: 120_000 })
      .execute('1', { from: 'nope' }, ctx);
    expect(text(result)).toContain('and 6 others');
    expect(text(result).length).toBeLessThan(220);
  });

  it('AC-23: every refusal is a NON-ERROR result, and each is counted (D-6 / D-11)', async () => {
    // The counter lives on the TOOL, not inside the predicate: a predicate with
    // a counter inside it is a predicate people stop trusting.
    const bus = new TeamBus(['a1']);
    const wait = makeTeamWait(bus, 'a1', { getAgent: () => null, maxWaitMs: 120_000 });
    expect(bus.blockedWaitCount('a1')).toBe(0);
    const first = await wait.execute('1', {}, ctx);
    const second = await wait.execute('2', {}, ctx);
    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(bus.blockedWaitCount('a1')).toBe(2);
  });

  it('checkWaitable is PURE: it registers nothing and counts nothing (D-6)', () => {
    const bus = new TeamBus(['a1', 'a2']);
    bus.checkWaitable('a1', { from: 'nope', timeoutMs: 1000 });
    expect(bus.blockedWaitCount('a1')).toBe(0);
    // No waiter was registered, so a later send goes to the mailbox, not to a
    // phantom waiter that nothing will ever settle.
    bus.send('a2', 'a1', 's', 'b');
    expect(bus.drain('a1')).toHaveLength(1);
  });

  it('resolveLabel canonicalizes exactly what `wait()` will compare against', () => {
    const bus = new TeamBus(['Api', 'routes']);
    expect(bus.resolveLabel('  API  ')).toBe('Api');
    expect(bus.resolveLabel('ROUTES')).toBe('routes');
    expect(bus.resolveLabel('lead')).toBeUndefined();
    expect(bus.resolveLabel('nope')).toBeUndefined();
  });
});

describe('renderMailBlock', () => {
  it('is ASCII and names the sender', () => {
    const block = renderMailBlock([
      { from: 'a1', to: 'a2', subject: 's', body: 'b', at: 0 },
    ]);
    expect(block).toContain('<team_mail>');
    expect(block).toContain('from a1: s');
    expect(block).not.toMatch(/[^\x00-\x7f]/);
  });
});
