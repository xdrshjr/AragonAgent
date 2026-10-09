import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderRegistry, type Agent, type Message } from '@aragon-agent/core';
import { AgentController } from '../agent/controller.js';
import { DEFAULT_CONFIG, DEFAULT_SKILLS_RUNTIME, type CliConfig } from '../config/schema.js';
import { scriptedProvider } from './helpers/scripted-provider.js';
import type { SkillService } from '../skills/service.js';
import type { TodoStore } from '../todo/store.js';

const controllers: AgentController[] = [];
function setup() {
  const config = { ...DEFAULT_CONFIG, cwd: process.cwd(), color: false, unicode: false,
    submitCount: 0, startInPlanMode: false,
    skillsRuntime: DEFAULT_SKILLS_RUNTIME, skills: { ...DEFAULT_CONFIG.skills, enabled: false },
    team: { ...DEFAULT_CONFIG.team, enabled: false }, fast: { ...DEFAULT_CONFIG.fast, enabled: false },
    compaction: { ...DEFAULT_CONFIG.compaction, enabled: true, archive: false },
    apiKeys: { anthropic: 'test' },
  } as CliConfig;
  const controller = new AgentController(config, { notify: vi.fn() });
  controllers.push(controller);
  const engine = (controller as unknown as { agent: Agent }).agent;
  const history: Message[] = Array.from({ length: 6 }, (_, i): Message[] => [
    { role: 'user', content: `task ${i}`, timestamp: i },
    { role: 'assistant', content: [{ type: 'text', text: `answer ${i} ${'x'.repeat(4000)}` }] },
  ]).flat();
  controller.replaceMessages(history);
  return { controller, engine };
}

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  vi.restoreAllMocks();
});

describe('controller with real compaction wiring', () => {
  it('releases the compactor before publishing cancellation to the next caller', async () => {
    const { controller } = setup();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(ProviderRegistry.prototype, 'complete').mockImplementation(() => {
      entered();
      return new Promise(() => {});
    });
    const first = controller.compactNow();
    await started;
    controller.abort();
    expect(await first).toEqual({ ok: false, reason: 'aborted' });
    expect(controller.getCompactionSnapshot().inFlight).toBe(false);
    const second = controller.compactNow();
    controller.abort();
    expect(await second).toEqual({ ok: false, reason: 'aborted' });
  });

  it('starts a fresh user turn while consuming queued input exactly once', async () => {
    const { controller, engine } = setup();
    const internals = controller as unknown as {
      takeAskRound(): unknown; skillsEnabled: boolean; skills: SkillService; todos: TodoStore;
    };
    internals.skillsEnabled = true;
    internals.skills.getRegistry().enterFrame('previous-task');
    internals.skills.queueFrame('queued-task');
    internals.todos.write([{ content: 'previous plan', status: 'pending' }]);
    internals.takeAskRound();
    expect(controller.getPlanStatus().askRoundsUsed).toBe(1);
    const queued = controller.queueUserMessage('new task after compaction');
    const receipts: string[] = [];
    engine.subscribe((event) => {
      if (event.type === 'steering_accepted') receipts.push(...event.ids);
    });
    const provider = scriptedProvider('anthropic', [{ kind: 'assistant', text: 'done' }]);
    controller.getProviderRegistry().register(provider);
    await controller.continue();
    expect(controller.getPlanStatus().askRoundsUsed).toBe(0);
    expect(internals.skills.frameNames()).toEqual(['queued-task']);
    expect(controller.getTodoSnapshot()).toBeNull();
    expect(receipts).toEqual([queued]);
    expect(controller.hasPendingUserMessages()).toBe(false);
    expect(controller.getMessages().filter((message) => message.role === 'user'
      && message.content === 'new task after compaction')).toHaveLength(1);
  });
});
