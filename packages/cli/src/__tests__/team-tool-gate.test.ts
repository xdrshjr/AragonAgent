import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SkillRegistry,
  type AgentTool,
  type ToolPolicyDecision,
  type ToolResult,
} from '@aragon-agent/core';
import { buildSubagentTools, type SubagentDeps } from '../team/subagent.js';
import { TeamBus } from '../team/bus.js';
import { TeamHumanQueue } from '../team/human-queue.js';
import { TEAM_SUBAGENT_TOOL_NAMES } from '../team/limits.js';
import {
  DEFAULT_LOG_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_SKILLS_RUNTIME,
  DEFAULT_TEAM_CONFIG,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_TODO_CONFIG,
  DEFAULT_BASH_CONFIG,
  type CliConfig,
} from '../config/schema.js';
import type { AgentMode } from '../agent/agent-mode.js';
import type { SubagentSpec } from '../team/types.js';
import { DEFAULT_FAST_CONFIG, DEFAULT_UPDATE_CONFIG } from '../config/schema.js';

const ctx = {};
const dir = mkdtempSync(join(tmpdir(), 'aragon-team-gate-'));

function text(result: ToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

function config(): CliConfig {
  return {
    fast: DEFAULT_FAST_CONFIG,
    update: DEFAULT_UPDATE_CONFIG,
    provider: 'anthropic',
    model: 'm',
    thinkingLevel: 'off',
    showThinking: false,
    liveToolOutput: false,
    contextWindow: null,
    theme: 'auto',
    reducedMotion: false,
    exitTranscript: true,
    transcriptWindow: 300,
    transcriptRetain: 1000,
    renderGovernor: true,
    maxRenderIntervalMs: 320,
    diffRender: true,
    syncOutput: true,
    confirmTools: false,
    toolTimeoutMs: 180_000,
    idleTimeoutMs: 210_000,
    apiKeys: { anthropic: 'k' },
    historyEnabled: true,
    density: 'comfortable',
    hints: true,
    mouse: true,
    mouseSelect: true,
    paste: true,
    scrollResumeMs: 5000,
    submitCount: 0,
    startInPlanMode: false,
    planModeMaxAskRounds: 4,
    planModeHumanTimeoutMs: 1_800_000,
    skills: DEFAULT_SKILLS_CONFIG,
    skillsRuntime: DEFAULT_SKILLS_RUNTIME,
    log: DEFAULT_LOG_CONFIG,
    team: DEFAULT_TEAM_CONFIG,
    todo: DEFAULT_TODO_CONFIG,
    bash: DEFAULT_BASH_CONFIG,
    retry: DEFAULT_RETRY_CONFIG,
    // The NINTH nested section. `enabled: false` on purpose: these fixtures
    // are about other subsystems, and the same `enabled: false` appears above
    // for `skills`, `team` and `todo` for exactly that reason.
    compaction: { ...DEFAULT_COMPACTION_CONFIG, enabled: false },
    cwd: dir,
    color: true,
  };
}

const SPEC: SubagentSpec = {
  label: 'a2',
  description: 'read the auth middleware',
  prompt: 'Read src/auth and report.',
  readOnly: false,
  tier: 'main',
};

function deps(over: Partial<SubagentDeps> = {}): SubagentDeps {
  return {
    bus: new TeamBus(['a1', 'a2', 'a3']),
    config: config(),
    providerRegistry: {} as SubagentDeps['providerRegistry'],
    getCwd: () => dir,
    getMode: (): AgentMode => 'build',
    getApiKey: () => 'k',
    confirmTools: false,
    agentFactory: () => {
      throw new Error('no agent needed for a tool-set assertion');
    },
    ...over,
  };
}

function names(spec: SubagentSpec = SPEC, over: Partial<SubagentDeps> = {}): string[] {
  return buildSubagentTools(spec, deps(over), () => null).map((t) => t.name);
}

describe('what a subagent may call', () => {
  it('NEVER gets `task` — depth is capped at one by construction (D-3 / AC-3)', () => {
    // A counter can be miscounted; an absent tool cannot be called.
    expect(names()).not.toContain('task');
  });

  it('gets no `ask_user` and no `submit_plan` — there is no human attached', () => {
    expect(names()).not.toContain('ask_user');
    expect(names()).not.toContain('submit_plan');
  });

  it('gets `skill_find` but NOT `skill` (D-16 / P0-3 / AC-19)', () => {
    // `createSkillTool` calls `enterFrame()` on the registry it is handed, and
    // the only registry in the process is the LEAD's. A child loading a skill
    // would narrow the lead's own turn-scoped ceiling and rewrite the lead's
    // system prompt from inside the tool call the lead is blocked in — from up
    // to `maxConcurrent` places at once, and nothing in the child's report would
    // show any of it.
    const withSkills = names(SPEC, { skillRegistry: new SkillRegistry() });
    expect(withSkills).toContain('skill_find');
    expect(withSkills).not.toContain('skill');
    expect(withSkills).not.toContain('skill_install');
    expect(withSkills).not.toContain('skill_create');
  });

  it("AC-19: a whole child tool set leaves the lead's frame stack byte-identical", async () => {
    // THE TOOL LIST IS THE FIX; THE FRAME STACK IS THE PROPERTY (spec §12
    // condition 3). Asserting only the former lets a future change reintroduce
    // the hazard through a different door.
    const registry = new SkillRegistry();
    const before = JSON.stringify({
      active: registry.activeNames,
      // THE FRAME STACK, which is the property AC-19 is actually about: a child
      // that loaded a skill would push a name onto `frameNames` and narrow what
      // the LEAD may do once the report returns.
      frames: registry.frameNames,
      pending: registry.pendingFrameNames,
    });

    const tools = buildSubagentTools(SPEC, deps({ skillRegistry: registry }), () => null);
    for (const tool of tools) {
      if (tool.name === 'skill_find') await tool.execute('1', { query: 'anything' }, ctx);
    }

    expect(
      JSON.stringify({
        active: registry.activeNames,
        frames: registry.frameNames,
        pending: registry.pendingFrameNames,
      }),
    ).toBe(before);
  });

  it('gets exactly the two comm tools', () => {
    const list = names();
    for (const name of TEAM_SUBAGENT_TOOL_NAMES) expect(list).toContain(name);
  });

  it('has no skill tool at all when skills are off, matching the --no-skills shape', () => {
    expect(names().filter((n) => n.startsWith('skill'))).toEqual([]);
  });
});

describe('--confirm inside a child (§3.11 / I-4 / AC-16)', () => {
  function gated(queue: TeamHumanQueue): Record<string, AgentTool> {
    return Object.fromEntries(
      buildSubagentTools(SPEC, deps({ confirmTools: true, humanQueue: queue }), () => null).map(
        (t) => [t.name, t],
      ),
    );
  }

  it('labels the dialog with the child that is asking, so the user can attribute it', async () => {
    const shown: string[] = [];
    const tools = gated(
      new TeamHumanQueue(async (req) => {
        shown.push(req.summary);
        return true;
      }),
    );
    await tools.write_file!.execute('1', { path: 'ok.txt', content: 'hi' }, ctx);
    expect(shown).toEqual([`[${SPEC.label}] Write: ok.txt`]);
  });

  /**
   * THE QUEUE'S ABORT PATH IS ONLY REACHABLE IF THE CHILD'S SIGNAL GETS THERE,
   * and `withConfirmation` is the only frame that holds it — hence
   * `ConfirmRequest.signal`. Asserting this through the REAL tool set rather
   * than by calling `TeamHumanQueue.request` directly is the point of the case:
   * the queue's own unit test passes a signal by hand, so it would stay green
   * with the production wiring missing, and an `Esc` mid-dispatch would pop a
   * fresh dialog for every request still in the FIFO.
   */
  it('an abort resolves a queued confirmation instead of raising a dialog (AC-16)', async () => {
    const shown: string[] = [];
    const tools = gated(
      new TeamHumanQueue(async (req) => {
        shown.push(req.summary);
        return true;
      }),
    );
    const aborted = new AbortController();
    aborted.abort();

    const result = await tools.write_file!.execute(
      '1',
      { path: 'never.txt', content: 'hi' },
      { signal: aborted.signal },
    );

    expect(result.isError).toBe(true);
    expect(shown).toEqual([]);
    // Denied, so the tool never ran: an abort must not become an approval.
    expect(existsSync(join(dir, 'never.txt'))).toBe(false);
  });
});

describe('plan mode reaches one level down (§3.11 / D-5 / R-13)', () => {
  const MUTATING = ['write_file', 'edit_file', 'bash'];

  it("refuses the mutating tools inside a child when the LEAD's session is in PLAN", async () => {
    const tools = Object.fromEntries(
      buildSubagentTools(SPEC, deps({ getMode: () => 'plan' }), () => null).map((t) => [t.name, t]),
    );
    for (const name of MUTATING) {
      const result = await tools[name]!.execute('1', { path: 'x', content: 'y', command: 'ls' }, ctx);
      expect(result.isError, name).toBe(true);
    }
    // Reading is still allowed: parallel research is plan mode's best use.
    expect((await tools.list_dir!.execute('2', {}, ctx)).isError).toBeFalsy();
  });

  it('`readOnly: true` tightens ONE child even in a BUILD session (D-13)', async () => {
    // There must be no field anywhere that gives a child MORE permission than
    // the session it was spawned from, so this direction is the only one.
    const readOnly = Object.fromEntries(
      buildSubagentTools({ ...SPEC, readOnly: true }, deps(), () => null).map((t) => [t.name, t]),
    );
    expect((await readOnly.bash!.execute('1', { command: 'echo hi' }, ctx)).isError).toBe(true);

    const normal = Object.fromEntries(
      buildSubagentTools(SPEC, deps(), () => null).map((t) => [t.name, t]),
    );
    expect((await normal.list_dir!.execute('2', {}, ctx)).isError).toBeFalsy();
  });

  it('reads the mode LIVE, so a mid-dispatch switch to PLAN tightens a running child', async () => {
    let mode: AgentMode = 'build';
    const tools = Object.fromEntries(
      buildSubagentTools(SPEC, deps({ getMode: () => mode }), () => null).map((t) => [t.name, t]),
    );
    expect((await tools.bash!.execute('1', { command: 'node -e ""' }, ctx)).isError).toBeFalsy();
    mode = 'plan';
    expect((await tools.bash!.execute('2', { command: 'node -e ""' }, ctx)).isError).toBe(true);
  });
});

describe("the lead's skills ceiling reaches one level down (R-6)", () => {
  const decision: ToolPolicyDecision = {
    mode: 'enforce',
    allowed: new Set(['read_file', 'grep']),
    sources: [{ name: 'strict-skill', declared: ['read_file', 'grep'], granted: ['read_file', 'grep'] }],
    sourceNames: ['strict-skill'],
    ignored: [],
  };

  it('constrains a child with the same closure — delegation is not a bypass', async () => {
    const tools = Object.fromEntries(
      buildSubagentTools(SPEC, deps({ toolPolicy: () => decision }), () => null).map((t) => [
        t.name,
        t,
      ]),
    );
    const refused = await tools.bash!.execute('1', { command: 'echo hi' }, ctx);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('not permitted');
    expect((await tools.grep!.execute('2', { pattern: 'x' }, ctx)).isError).toBeFalsy();
  });

  it('EXEMPTS the two comm tools, or the channel dead-ends (§3.11)', async () => {
    // `team_send` / `team_wait` are not in the LEAD's registered tool list, so
    // evaluating them against its ceiling refuses them — the same dead end the
    // skill floor exists to prevent one level up.
    const tools = Object.fromEntries(
      buildSubagentTools(SPEC, deps({ toolPolicy: () => decision }), () => null).map((t) => [
        t.name,
        t,
      ]),
    );
    const sent = await tools.team_send!.execute('1', { to: 'a1', subject: 's', body: 'b' }, ctx);
    expect(sent.isError).toBeFalsy();
    expect(text(sent)).toContain('Delivered to a1');
  });

  it("labels a child's refusal and does NOT advance the lead's escalation counter (P1-3)", async () => {
    // `evaluateToolCall` returns a notice naming a tool and a skill but NO
    // agent, so three children hitting one refusal would surface three notices
    // the user cannot attribute. The lead's deny-escalation counter is
    // turn-scoped on the lead; a child cannot retry the lead's turn.
    const seen: Array<{ label: string; tool: string }> = [];
    const tools = Object.fromEntries(
      buildSubagentTools(
        SPEC,
        deps({
          toolPolicy: () => decision,
          onChildToolPolicyEvent: (e) => seen.push({ label: e.label, tool: e.tool }),
        }),
        () => null,
      ).map((t) => [t.name, t]),
    );
    await tools.bash!.execute('1', { command: 'echo hi' }, ctx);
    expect(seen).toEqual([{ label: 'a2', tool: 'bash' }]);
  });
});

describe('mail rides on every tool a child can call (D-4)', () => {
  it('wraps the comm tools too, so a child that only messages still receives', async () => {
    const bus = new TeamBus(['a1', 'a2']);
    const tools = Object.fromEntries(
      buildSubagentTools(SPEC, deps({ bus }), () => null).map((t) => [t.name, t]),
    );
    bus.send('a1', 'a2', 'routes.ts is mine', 'do not touch it');
    const sent = await tools.team_send!.execute('1', { to: 'a1', subject: 'ack', body: 'ok' }, ctx);
    expect(text(sent)).toContain('<team_mail>');
    expect(text(sent)).toContain('from a1: routes.ts is mine');
  });
});

describe('AC-11 — the --no-team array is the pre-team array', () => {
  it('an empty teamTools option adds no wrapper and no entry', async () => {
    const { createBuiltinTools } = await import('../tools/index.js');
    const sentinel: AgentTool = {
      name: 'sentinel',
      label: 'Sentinel',
      description: 'identity probe',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [] }),
    };
    const bare = createBuiltinTools({ getCwd: () => dir, skillTools: [sentinel], teamTools: [] });
    expect(bare).toHaveLength(8);
    // Object identity, not a name comparison: with a wrapper in place this
    // would be a copy, and "the off switch really is off" would demote from a
    // fact anyone can check to an argument someone has to trust.
    expect(bare[bare.length - 1]).toBe(sentinel);
    expect(bare.map((t) => t.name)).not.toContain('task');
  });
});

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
});
