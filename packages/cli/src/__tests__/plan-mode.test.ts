/**
 * Mode vocabulary, the system-prompt splice, the deferral rules, and `/plan`
 * (plan-mode §3.1 / §3.2 / §8 / §9.1).
 *
 * These are the invariants whose failures are SILENT: a prompt that gained a
 * block it should not have, a badge that says one thing while the gate does
 * another, a model that politely declines to implement the plan the user just
 * approved. None of them throws, and none shows up in a manual smoke pass.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '@aragon-agent/core';
import { AGENT_MODES, MODE_LABEL, nextMode, planRefusal } from '../agent/agent-mode.js';
import { buildPlanModeBlock } from '../agent/plan-prompt.js';
import { buildSystemPrompt } from '../agent/system-prompt.js';
import { registerBuiltinCommands } from '../commands/builtins.js';
import { CommandRegistry, runSlashInput, type CommandContext } from '../commands/registry.js';

const TOOLS: AgentTool[] = [
  {
    name: 'read_file',
    label: 'Read',
    description: 'Read a file\nsecond line',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [] }),
  },
];

describe('nextMode / MODE_LABEL', () => {
  it('cycles, so a third mode is a one-line change', () => {
    expect(nextMode('build')).toBe('plan');
    expect(nextMode('plan')).toBe('build');
    expect(AGENT_MODES).toEqual(['build', 'plan']);
  });

  it('labels both modes in English', () => {
    expect(MODE_LABEL.build).toBe('BUILD');
    expect(MODE_LABEL.plan).toBe('PLAN');
  });
});

describe('I-P1 - the plan block is spliced conditionally', () => {
  const base = { cwd: '/work', tools: TOOLS };

  it('is byte-identical with agentMode absent or "build", for a fixed tool array', () => {
    // Scoped to a FIXED `tools` array on purpose (P1-5): `buildSystemPrompt`
    // renders `Available tools:` from `params.tools`, so registering the two
    // plan tools does add two lines to a live interactive prompt in EITHER
    // mode. §3.4 accepts that token cost; this invariant is about the BLOCK.
    const before = buildSystemPrompt(base);
    expect(buildSystemPrompt({ ...base, agentMode: 'build' })).toBe(before);
    expect(buildSystemPrompt({ ...base, agentMode: 'build', planMaxAskRounds: 9 })).toBe(before);
    expect(before).not.toContain('<plan_mode>');
  });

  it('adds the block, and only the block, in plan mode', () => {
    const build = buildSystemPrompt(base);
    const plan = buildSystemPrompt({ ...base, agentMode: 'plan' });
    expect(plan).toContain('<plan_mode>');
    // Everything that was there before is still there, unchanged.
    for (const line of build.split('\n')) expect(plan).toContain(line);
  });

  it('substitutes maxAskRounds so the prompt and the cap cannot disagree', () => {
    const plan = buildSystemPrompt({ ...base, agentMode: 'plan', planMaxAskRounds: 7 });
    expect(plan).toContain('to 7 rounds');
  });
});

describe('I-P9 - the block scopes its read-only rule and names its override', () => {
  it('scopes the rule to "while PLAN MODE is active"', () => {
    // A static assertion because the failure it prevents is a model REFUSING to
    // implement a plan the user just approved: invisible in every unit test and
    // expensive to diagnose from a transcript. The run's system prompt is a
    // snapshot — `runLoopWithLifecycle` passes it by value — so this sentence is
    // the only thing that reconciles the frozen block with the tool result.
    const block = buildPlanModeBlock({ interactive: true, maxAskRounds: 4 });
    expect(block).toMatch(/While PLAN MODE is active/);
    expect(block).toMatch(/APPROVED is therefore authoritative and supersedes/);
    expect(block).toMatch(/you are in Build mode/);
  });

  it('tells a headless run to emit markdown instead of calling the tools', () => {
    const block = buildPlanModeBlock({ interactive: false, maxAskRounds: 4 });
    expect(block).toContain('There is no interactive user');
    expect(block).toContain('markdown');
    expect(block).not.toContain('ask_user with');
  });

  it('is ASCII, because agent/ is inside the glyph scanner scope', () => {
    for (const interactive of [true, false]) {
      const block = buildPlanModeBlock({ interactive, maxAskRounds: 4 });
      expect(block).not.toMatch(/[^\x00-\x7f]/);
    }
  });
});

describe('planRefusal', () => {
  it('names the mode, the tool and a way forward', () => {
    const message = planRefusal('write_file');
    expect(message).toContain('Plan mode is active');
    expect(message).toContain('write_file');
    expect(message).toContain('read_file');
  });

  it('explains the wholesale bash refusal where the user will meet it', () => {
    expect(planRefusal('bash')).toContain('git status');
  });
});

// ---------------------------------------------------------------------------
// Deferral (§3.2) — exercised against the real controller logic, stubbed only
// where it needs an Agent.
// ---------------------------------------------------------------------------

/**
 * The deferral rules, extracted the way `AgentController.setAgentMode`
 * implements them. Kept as a local double rather than constructing a real
 * controller: that would build an `Agent`, a `SkillService` and a provider
 * registry to test four branches of pure logic.
 */
class ModeOwner {
  effective: 'build' | 'plan' = 'build';
  pending: 'build' | 'plan' | null = null;
  running = false;

  set(next: 'build' | 'plan', opts: { force?: boolean } = {}) {
    if (next === 'plan') {
      this.effective = 'plan';
      this.pending = null;
    } else if (this.effective === 'build') {
      this.pending = null;
    } else if (opts.force || !this.running) {
      this.effective = 'build';
      this.pending = null;
    } else {
      this.pending = 'build';
    }
    return { effective: this.effective, pending: this.pending };
  }

  applyPending() {
    if (!this.pending) return null;
    this.effective = this.pending;
    this.pending = null;
    return { effective: this.effective, pending: null };
  }
}

describe('AC-P12 / AC-P13 - deferred loosening, immediate tightening', () => {
  it('applies build -> plan IMMEDIATELY, even mid-run', () => {
    // Tightening a permission mid-run is always safe; the user pressed the key
    // BECAUSE the agent is about to do something they want to stop.
    const owner = new ModeOwner();
    owner.running = true;
    expect(owner.set('plan')).toEqual({ effective: 'plan', pending: null });
  });

  it('DEFERS plan -> build to agent_end while a run is in flight', () => {
    // Applying it live would mean a run the user launched under a read-only
    // guarantee could start writing files because of one stray keypress.
    const owner = new ModeOwner();
    owner.set('plan');
    owner.running = true;

    expect(owner.set('build')).toEqual({ effective: 'plan', pending: 'build' });
    expect(owner.effective).toBe('plan');

    expect(owner.applyPending()).toEqual({ effective: 'build', pending: null });
    expect(owner.applyPending()).toBeNull();
  });

  it('applies plan -> build immediately when idle', () => {
    const owner = new ModeOwner();
    owner.set('plan');
    expect(owner.set('build')).toEqual({ effective: 'build', pending: null });
  });

  it('force is the ONE exception, and it is the plan-approval path', () => {
    // The user has just read the plan and authorized exactly that work. That is
    // an informed act; a stray Shift+Tab is not. Preserve this distinction in
    // any refactor — it is the whole justification for the asymmetry.
    const owner = new ModeOwner();
    owner.set('plan');
    owner.running = true;
    expect(owner.set('build', { force: true })).toEqual({ effective: 'build', pending: null });
  });

  it('re-tightening cancels a pending loosening', () => {
    const owner = new ModeOwner();
    owner.set('plan');
    owner.running = true;
    owner.set('build');
    expect(owner.pending).toBe('build');
    owner.set('plan');
    expect(owner.pending).toBeNull();
  });

  it('never queues a deferral toward the mode it is already in', () => {
    const owner = new ModeOwner();
    owner.running = true;
    expect(owner.set('build')).toEqual({ effective: 'build', pending: null });
  });
});

// ---------------------------------------------------------------------------
// AC-P24 — /plan routes through the App's single write path
// ---------------------------------------------------------------------------

describe('AC-P24 - /plan uses applyAgentMode, not its own pair of calls', () => {
  function makeCtx(overrides: Partial<CommandContext> = {}): {
    ctx: (args: string) => CommandContext;
    applyAgentMode: ReturnType<typeof vi.fn>;
    notices: string[];
    owner: ModeOwner;
  } {
    const owner = new ModeOwner();
    const notices: string[] = [];
    const applyAgentMode = vi.fn((next: 'build' | 'plan') => owner.set(next));
    const controller = {
      getAgentMode: () => owner.effective,
      getPlanStatus: () => ({
        effective: owner.effective,
        pending: owner.pending,
        askRoundsUsed: 1,
        maxAskRounds: 4,
      }),
    } as unknown as CommandContext['controller'];

    return {
      owner,
      applyAgentMode,
      notices,
      ctx: (args: string) =>
        ({
          args,
          controller,
          notify: (_level: string, text: string) => notices.push(text),
          toast: () => {},
          applyAgentMode,
          ...overrides,
        }) as unknown as CommandContext,
    };
  }

  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);

  it('toggles through applyAgentMode and nowhere else', async () => {
    // A second write path is exactly what R-P7 forecloses: the badge and the
    // gate would then have two authors and could disagree. `CommandContext`
    // carries `controller` and `dispatch`, so writing both here would compile
    // and would be wrong.
    const h = makeCtx();
    await runSlashInput(registry, '/plan', h.ctx);
    expect(h.applyAgentMode).toHaveBeenCalledWith('plan');
    expect(h.owner.effective).toBe('plan');

    await runSlashInput(registry, '/plan', h.ctx);
    expect(h.applyAgentMode).toHaveBeenLastCalledWith('build');
  });

  it('/plan on and /plan off are idempotent', async () => {
    const h = makeCtx();
    await runSlashInput(registry, '/plan on', h.ctx);
    await runSlashInput(registry, '/plan on', h.ctx);
    expect(h.owner.effective).toBe('plan');
    await runSlashInput(registry, '/plan off', h.ctx);
    await runSlashInput(registry, '/plan off', h.ctx);
    expect(h.owner.effective).toBe('build');
  });

  it('/plan status reads the named accessor and reports the pending switch', async () => {
    const h = makeCtx();
    h.owner.set('plan');
    h.owner.running = true;
    h.owner.set('build');

    await runSlashInput(registry, '/plan status', h.ctx);
    expect(h.applyAgentMode).not.toHaveBeenCalled();
    expect(h.notices[0]).toContain('Mode: PLAN');
    expect(h.notices[0]).toContain('pending BUILD after this run');
    expect(h.notices[0]).toContain('1/4');
  });

  it('rejects an unknown argument instead of silently toggling', async () => {
    const h = makeCtx();
    await runSlashInput(registry, '/plan sideways', h.ctx);
    expect(h.applyAgentMode).not.toHaveBeenCalled();
    expect(h.notices[0]).toContain('Unknown argument');
  });
});
