/**
 * The session round-trip and the controller surface
 * (AC-30, AC-33, AC-34, AC-36, AC-37, AC-38).
 *
 * AC-36 is the second of the two silent, user-triggerable failures this feature
 * had to be reviewed to find (P0-2): `/resume` calls `replaceMessages`, which
 * discards the conversation the current list belonged to. If nothing clears the
 * store, the rail keeps rendering a plan whose entire justification — "the model
 * still believes in it" — has just been deleted. That is I-2 INVERTED, and §1.2
 * ranks it below having no panel at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = { root: '' };

vi.mock('../config/store.js', async () => {
  const actual = await vi.importActual<typeof import('../config/store.js')>('../config/store.js');
  return { ...actual, updatePersistedConfig: vi.fn(() => ({})) };
});

vi.mock('../skills/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../skills/paths.js')>('../skills/paths.js');
  const user = (): string => join(tmp.root, 'user');
  return {
    ...actual,
    getBundledSkillsDir: () => join(tmp.root, 'bundled'),
    getUserSkillsDir: user,
    getStagingDir: () => join(user(), '.staging'),
    getTrashDir: () => join(user(), '.staging', '.trash'),
    resolveSkillRoots: () => [{ dir: user(), scope: 'user' as const, writable: true }],
  };
});

const { AgentController, DENY_ALL_APPROVAL } = await import('../agent/controller.js');
const { loadSession, normalizeLoadedEntries, saveSession } = await import(
  '../session/persist.js'
);
const { buildSubagentTools } = await import('../team/subagent.js');
const { TeamBus } = await import('../team/bus.js');
const {
  DEFAULT_LOG_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_SKILLS_RUNTIME,
  DEFAULT_TEAM_CONFIG,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_TODO_CONFIG,
  DEFAULT_BASH_CONFIG,
} = await import('../config/schema.js');
import type { CliConfig } from '../config/schema.js';
import type { Entry } from '../agent/reducer.js';
import type { TodoEvent } from '../todo/types.js';
import type { SubagentDeps } from '../team/subagent.js';
import type { AgentMode } from '../agent/agent-mode.js';
import { DEFAULT_FAST_CONFIG, DEFAULT_UPDATE_CONFIG } from '../config/schema.js';

const dir = mkdtempSync(join(tmpdir(), 'aragon-todo-session-'));

function config(over: Partial<CliConfig> = {}): CliConfig {
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
    skills: { ...DEFAULT_SKILLS_CONFIG, enabled: false },
    skillsRuntime: DEFAULT_SKILLS_RUNTIME,
    log: DEFAULT_LOG_CONFIG,
    team: { ...DEFAULT_TEAM_CONFIG, enabled: false },
    todo: DEFAULT_TODO_CONFIG,
    bash: DEFAULT_BASH_CONFIG,
    retry: DEFAULT_RETRY_CONFIG,
    // The NINTH nested section. `enabled: false` on purpose: these fixtures
    // are about other subsystems, and the same `enabled: false` appears above
    // for `skills`, `team` and `todo` for exactly that reason.
    compaction: { ...DEFAULT_COMPACTION_CONFIG, enabled: false },
    cwd: tmp.root,
    color: true,
    ...over,
    keyboardEnhancement: over.keyboardEnhancement ?? false,
  };
}

const THREE = [
  { content: 'Read the reducer', activeForm: 'Reading the reducer', status: 'completed' },
  { content: 'Design the store', activeForm: 'Designing the store', status: 'in_progress' },
  { content: 'Add the test', activeForm: 'Adding the test', status: 'pending' },
];

beforeEach(() => {
  tmp.root = mkdtempSync(join(tmpdir(), 'aragon-todo-ctrl-'));
  mkdirSync(join(tmp.root, 'user'), { recursive: true });
});
afterEach(() => rmSync(tmp.root, { recursive: true, force: true }));

describe('AC-33: a session saved mid-run resumes settled and interrupted', () => {
  const liveCard: Entry = {
    id: 'e1',
    kind: 'todo',
    items: THREE.map((i) => ({ ...i, status: i.status as never })),
    doneCount: 1,
    total: 3,
    live: true,
  };

  it('rewrites a live card to { live: false, interrupted: true } on load', () => {
    // Two things go wrong without this. The card claims to be running while
    // nothing is (P2-6), and `Transcript`'s settled boundary is MONOTONIC, so an
    // entry that never settles is re-rendered on every frame for the rest of the
    // session (C-5).
    const file = join(dir, 'mid-run.json');
    saveSession(file, {
      model: { providerId: 'anthropic', modelId: 'm' },
      messages: [],
      entries: [liveCard],
      todos: liveCard.kind === 'todo' ? liveCard.items : [],
    });

    const loaded = loadSession(file);
    const card = loaded.entries[0]!;
    expect(card.kind === 'todo' && card.live).toBe(false);
    expect(card.kind === 'todo' && card.interrupted).toBe(true);
    expect(loaded.todos).toHaveLength(3);
  });

  it('SESSION_VERSION stays 1, and a pre-feature file simply has no todos', () => {
    const file = join(dir, 'legacy.json');
    saveSession(file, {
      model: { providerId: 'anthropic', modelId: 'm' },
      messages: [],
      entries: [],
      todos: [],
    });
    const loaded = loadSession(file);
    expect(loaded.version).toBe(1);
    expect(loaded.todos).toEqual([]);
  });
});

describe('AgentController todo surface (§3.6a)', () => {
  function controller(over: Partial<CliConfig> = {}, panelCapable = true) {
    return new AgentController(config(over), {
      approval: DENY_ALL_APPROVAL,
      todoPanelCapable: panelCapable,
    });
  }

  it('AC-30: todo.enabled: false yields the pre-todo tool array and prompt', async () => {
    const { buildSystemPrompt } = await import('../agent/system-prompt.js');
    // `bash: BASH_OFF` alongside, for the reason `skills-controller.test.ts`
    // states about `TEAM_OFF` / `TODO_OFF`: background services are on by
    // default too, so a "byte-identical to the pre-todo builder output" claim
    // has to pin every other default-on subsystem off explicitly rather than
    // absorb it (background-service-supervision I-2).
    const off = controller({
      todo: { enabled: false, panel: true, followThrough: 'notify' },
      bash: { ...DEFAULT_BASH_CONFIG, background: false },
    });
    const tools = off.listTools();
    expect(tools.map((t) => t.name)).not.toContain('todo_write');
    // Byte-for-byte equality with the pre-todo builder output for this array.
    expect(off.getSystemPrompt()).toBe(buildSystemPrompt({ cwd: tmp.root, tools }));
    expect(off.getSystemPrompt()).not.toContain('<todo_planning>');
    expect(off.isTodoRegistered()).toBe(false);
    expect(off.getTodoSnapshot()).toBeNull();
    // Every caller may subscribe unconditionally.
    expect(() => off.subscribeTodos(() => {})()).not.toThrow();
  });

  it('registers todo_write and splices the block when it is on', () => {
    const on = controller();
    expect(on.listTools().map((t) => t.name)).toContain('todo_write');
    expect(on.getSystemPrompt()).toContain('<todo_planning>');
    expect(on.isTodoRegistered()).toBe(true);
    expect(on.isTodoEnabled()).toBe(true);
  });

  it('AC-37: setTodoEnabled REBUILDS THE PROMPT in both directions (P1-1)', () => {
    // Without the rebuild `<todo_planning>` survives `/todo off`: every call
    // comes back refused while the instructions telling the model to keep
    // calling are still in its own context, so it cannot diagnose the loop.
    const c = controller();
    expect(c.getSystemPrompt()).toContain('<todo_planning>');
    c.setTodoEnabled(false);
    expect(c.getSystemPrompt()).not.toContain('<todo_planning>');
    c.setTodoEnabled(true);
    expect(c.getSystemPrompt()).toContain('<todo_planning>');
  });

  it('AC-38: setTodoConfig changes the LIVE config, not just the file (P1-2)', () => {
    // `App` reads `controller.getConfig()` on every render and `persistConfig`
    // only writes the file, so without this `/todo panel off` would report
    // success and change nothing until the next launch.
    const c = controller();
    expect(c.getConfig().todo.panel).toBe(true);
    expect(c.setTodoConfig({ panel: false })).toEqual({
      enabled: true,
      panel: false,
      followThrough: 'notify',
    });
    expect(c.getConfig().todo.panel).toBe(false);
    expect(c.getTodoConfig().panel).toBe(false);
    // ...and it clamps, so a bad value reaches neither the runtime nor the file.
    expect(c.setTodoConfig({ panel: 'nope' } as never).panel).toBe(true);
  });

  it('P1-6: the prompt never claims a panel a headless session does not have', () => {
    expect(controller({}, true).getSystemPrompt()).toContain('beside the conversation');
    expect(controller({}, false).getSystemPrompt()).not.toContain('beside the conversation');
    // ...and `/todo panel off` moves the sentence too, because the rebuild
    // carries it.
    const c = controller({}, true);
    c.setTodoConfig({ panel: false });
    expect(c.getSystemPrompt()).not.toContain('beside the conversation');
  });

  it('AC-36: restoreTodos([]) clears; a real list comes back normalized', () => {
    const c = controller();
    const events: TodoEvent[] = [];
    c.subscribeTodos((e) => events.push(e));

    c.restoreTodos(THREE);
    expect(c.getTodoSnapshot()!.total).toBe(3);
    expect(events.at(-1)!.type).toBe('updated');

    c.restoreTodos([]);
    expect(c.getTodoSnapshot()).toBeNull();
    expect(events.at(-1)).toEqual({ type: 'cleared', reason: 'reset' });
  });

  it('AC-17: clearMessages() clears the store (/reset), and clearTodos is the user path', () => {
    const c = controller();
    c.restoreTodos(THREE);
    c.clearMessages();
    expect(c.getTodoSnapshot()).toBeNull();

    c.restoreTodos(THREE);
    c.clearTodos();
    expect(c.getTodoSnapshot()).toBeNull();
  });

  it('AC-16: steer() does not open a new turn, so it cannot age out the plan', () => {
    // A steer is a mid-turn interjection, not a new task — the same asymmetry
    // `askRounds = 0` already has.
    const c = controller();
    c.restoreTodos(THREE);
    for (let i = 0; i < 10; i += 1) c.steer('keep going');
    expect(c.getTodoSnapshot()!.total).toBe(3);
  });
});

describe('AC-34: a subagent never gets todo_write (D-14 / R-7)', () => {
  it('children run against ONE list under a full-replacement protocol', () => {
    // Last writer would win and the lead's plan would be destroyed by a
    // subagent's private checklist.
    const deps: SubagentDeps = {
      bus: new TeamBus(['a1', 'a2']),
      config: config(),
      providerRegistry: {} as SubagentDeps['providerRegistry'],
      getCwd: () => tmp.root,
      getMode: (): AgentMode => 'build',
      getApiKey: () => 'k',
      confirmTools: false,
      agentFactory: () => {
        throw new Error('no agent needed for a tool-set assertion');
      },
    };
    const names = buildSubagentTools(
      { label: 'a2', description: 'read auth', prompt: 'go', readOnly: false },
      deps,
      () => null,
    ).map((t) => t.name);
    expect(names).not.toContain('todo_write');
  });
});
