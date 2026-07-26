import { describe, expect, it } from 'vitest';
import { SkillRegistry } from '../skill-registry.js';
import { makeRecord } from './fixtures.js';

describe('SkillRegistry precedence and shadowing (D7)', () => {
  it('a later add of the same name wins and records the loser as shadowed', () => {
    const registry = new SkillRegistry();
    // Roots are walked low-to-high, so this is the real insertion order.
    registry.add(makeRecord({ name: 'a', scope: 'bundled', dir: '/bundled/a' }));
    registry.add(makeRecord({ name: 'a', scope: 'user', dir: '/user/a' }));
    registry.add(makeRecord({ name: 'a', scope: 'project', dir: '/project/a' }));
    registry.add(makeRecord({ name: 'a', scope: 'env', dir: '/env/a' }));

    const winner = registry.get('a')!;
    expect(winner.scope).toBe('env');
    expect(winner.shadowed.map((s) => s.scope)).toEqual(['project', 'user', 'bundled']);
  });

  it('catalog() orders env > project > user > bundled, then by name', () => {
    const registry = new SkillRegistry();
    for (const record of [
      makeRecord({ name: 'zeta', scope: 'user' }),
      makeRecord({ name: 'alpha', scope: 'user' }),
      makeRecord({ name: 'bundled-one', scope: 'bundled' }),
      makeRecord({ name: 'proj', scope: 'project' }),
      makeRecord({ name: 'envy', scope: 'env' }),
    ]) {
      registry.add(record);
    }
    expect(registry.catalog().map((r) => r.name)).toEqual([
      'envy',
      'proj',
      'alpha',
      'zeta',
      'bundled-one',
    ]);
  });

  it('disabled and invalid records stay in list() but leave catalog()', () => {
    const registry = new SkillRegistry();
    registry.add(makeRecord({ name: 'ok' }));
    registry.add(makeRecord({ name: 'off', disabled: true }));
    registry.add(makeRecord({ name: 'broken', invalid: true }));

    expect(registry.list().map((r) => r.name)).toEqual(['broken', 'off', 'ok']);
    expect(registry.catalog().map((r) => r.name)).toEqual(['ok']);
  });

  it('activation: manual is excluded from the catalog but still resolvable by name', () => {
    const registry = new SkillRegistry();
    registry.add(makeRecord({ name: 'hidden', activation: 'manual' }));
    expect(registry.catalog()).toEqual([]);
    expect(registry.get('hidden')).toBeDefined();
  });

  it('alwaysOn() picks activation: always plus the --skill forced names', () => {
    const registry = new SkillRegistry();
    registry.add(makeRecord({ name: 'rules', activation: 'always' }));
    registry.add(makeRecord({ name: 'plain' }));
    registry.add(makeRecord({ name: 'off', activation: 'always', disabled: true }));

    expect(registry.alwaysOn().map((r) => r.name)).toEqual(['rules']);
    expect(registry.alwaysOn(['plain']).map((r) => r.name).sort()).toEqual(['plain', 'rules']);
  });

  it('activate() is idempotent and reports prior activation', () => {
    const registry = new SkillRegistry();
    registry.add(makeRecord({ name: 'a' }));
    expect(registry.activate('a')).toBe(false);
    expect(registry.activate('a')).toBe(true);
    expect(registry.activeNames).toEqual(['a']);
  });

  it('clearActive() resets the session set (/reset, P2-9)', () => {
    const registry = new SkillRegistry();
    registry.activate('a');
    registry.clearActive();
    expect(registry.activeNames).toEqual([]);
    expect(registry.activate('a')).toBe(false);
  });

  it('setDisabled toggles catalog membership; replaceAll swaps the table', () => {
    const registry = new SkillRegistry();
    registry.add(makeRecord({ name: 'a' }));
    registry.setDisabled('a', true);
    expect(registry.catalog()).toEqual([]);

    registry.replaceAll([makeRecord({ name: 'b' })]);
    expect(registry.names()).toEqual(['b']);
  });
});

/**
 * The frame state machine (§5.1). Four events move a name and there is no fifth
 * — `controller.prompt()` and `controller.steer()` are the only two doors a user
 * message walks through (FG9), which is what makes a per-TURN scope possible at
 * all rather than a per-session one nobody would want.
 */
describe('SkillRegistry frames (§5.1 / D-G2 / D-G3)', () => {
  it('the skill tool enters the frame immediately', () => {
    const registry = new SkillRegistry();
    registry.enterFrame('a');
    expect(registry.frameNames).toEqual(['a']);
  });

  it('a slash command QUEUES, and the next user message promotes it (D-G2)', () => {
    // Entering directly would be wrong: `ctx.submit()` becomes the user message
    // that opens the very turn this skill is supposed to constrain, and
    // `beginUserTurn()` clears the frame on the way in.
    const registry = new SkillRegistry();
    registry.queueFrame('a');
    expect(registry.frameNames).toEqual([]);
    expect(registry.pendingFrameNames).toEqual(['a']);

    registry.beginUserTurn();
    expect(registry.frameNames).toEqual(['a']);
    expect(registry.pendingFrameNames).toEqual([]);
  });

  it('a new turn replaces the frame rather than accumulating (D-G1)', () => {
    const registry = new SkillRegistry();
    registry.enterFrame('old');
    registry.beginUserTurn();
    expect(registry.frameNames).toEqual([]);
  });

  it('steer promotes the queue WITHOUT clearing what is in force (D-G3)', () => {
    // Otherwise "ask a follow-up question mid-run" becomes the documented way to
    // drop the ceiling.
    const registry = new SkillRegistry();
    registry.enterFrame('running');
    registry.queueFrame('queued');
    registry.absorbPendingFrames();
    expect(registry.frameNames).toEqual(['queued', 'running']);
  });

  it('clearFrames drops both segments (/skills unload)', () => {
    const registry = new SkillRegistry();
    registry.enterFrame('a');
    registry.queueFrame('b');
    registry.clearFrames();
    expect(registry.frameNames).toEqual([]);
    expect(registry.pendingFrameNames).toEqual([]);
  });

  it('clearActive() clears the frames too, so /reset cannot leave one behind (§7.3)', () => {
    const registry = new SkillRegistry();
    registry.activate('a');
    registry.enterFrame('a');
    registry.clearActive();
    expect(registry.frameNames).toEqual([]);
  });

  it('frameRecords drops what is gone but frameNames keeps saying who it was (D-G20)', () => {
    const registry = new SkillRegistry();
    registry.add(makeRecord({ name: 'live', allowedTools: ['read_file'] }));
    registry.add(makeRecord({ name: 'off', allowedTools: ['read_file'], disabled: true }));
    registry.enterFrame('live');
    registry.enterFrame('off');
    registry.enterFrame('uninstalled');

    expect(registry.frameRecords().map((r) => r.name)).toEqual(['live']);
    // Keeping the names is what lets the service say "the ceiling was lifted"
    // instead of letting it evaporate without a word.
    expect(registry.frameNames).toEqual(['live', 'off', 'uninstalled']);
  });

  it('frameRecords resolves through the CURRENT table after replaceAll', () => {
    // `discover()` swaps every record object mid-turn (`/skills reload`, an
    // install). A held reference would keep reporting the old disabled flag.
    const registry = new SkillRegistry();
    registry.add(makeRecord({ name: 'a', allowedTools: ['read_file'] }));
    registry.enterFrame('a');
    registry.replaceAll([makeRecord({ name: 'a', allowedTools: ['read_file'], disabled: true })]);
    expect(registry.frameRecords()).toEqual([]);
  });
});

describe('SkillRegistry announce-once ledgers (§5.5 / P1-2)', () => {
  it('noteWarnOnce is per (skill, tool) and resets on a new TURN (AC-G26)', () => {
    // Session scope here would mute warn mode after its first message; per-call
    // would spam. Neither is what "tell me once per turn" means.
    const registry = new SkillRegistry();
    expect(registry.noteWarnOnce('a', 'bash')).toBe(true);
    expect(registry.noteWarnOnce('a', 'bash')).toBe(false);
    expect(registry.noteWarnOnce('a', 'write_file')).toBe(true);

    registry.beginUserTurn();
    expect(registry.noteWarnOnce('a', 'bash')).toBe(true);
  });

  it('noteFailOpenOnce is per SESSION and survives a turn boundary', () => {
    const registry = new SkillRegistry();
    expect(registry.noteFailOpenOnce('failopen:a')).toBe(true);
    registry.beginUserTurn();
    expect(registry.noteFailOpenOnce('failopen:a')).toBe(false);
    registry.clearActive();
    expect(registry.noteFailOpenOnce('failopen:a')).toBe(true);
  });

  it('countDeny accumulates per tool and resets on a new turn', () => {
    const registry = new SkillRegistry();
    expect(registry.countDeny('bash')).toBe(1);
    expect(registry.countDeny('bash')).toBe(2);
    expect(registry.countDeny('write_file')).toBe(1);
    registry.beginUserTurn();
    expect(registry.countDeny('bash')).toBe(1);
  });
});
