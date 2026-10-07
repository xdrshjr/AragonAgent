import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Agent, AgentEvent, ProviderRegistry } from '@aragon-agent/core';
import { AgentController } from '../agent/controller.js';
import { DEFAULT_CONFIG, DEFAULT_SKILLS_RUNTIME, type CliConfig } from '../config/schema.js';
import { App } from '../ui/App.js';
import type { FastWiring } from '../fast/wiring.js';

vi.mock('../config/prompt-history.js', () => ({
  loadPromptHistory: () => [], appendPrompt: () => [],
}));
vi.mock('../config/ui-state.js', () => ({
  bumpSubmitCount: () => 1, setMouseNoticeSeen: () => {}, getMouseNoticeSeen: () => true,
}));

const controllers: AgentController[] = [];

function setup(overrides: Partial<CliConfig> = {}) {
  const config = {
    ...DEFAULT_CONFIG, cwd: process.cwd(), color: false, unicode: false, submitCount: 0,
    startInPlanMode: false, skillsRuntime: DEFAULT_SKILLS_RUNTIME,
    skills: { ...DEFAULT_CONFIG.skills, enabled: false },
    compaction: { ...DEFAULT_CONFIG.compaction, enabled: false },
    team: { ...DEFAULT_CONFIG.team, enabled: false },
    fast: { ...DEFAULT_CONFIG.fast, enabled: false },
    apiKeys: { anthropic: 'test' },
    ...overrides,
  } as CliConfig;
  const controller = new AgentController(config, { notify: vi.fn() });
  controllers.push(controller);
  const engine = (controller as unknown as { agent: Agent }).agent;
  const emit = (event: AgentEvent) =>
    (engine as unknown as { emit(event: AgentEvent): void }).emit(event);
  return { controller, engine, emit };
}

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('controller queue identities', () => {
  it('does not reuse identities across controller instances or resumed histories', () => {
    const first = setup().controller;
    const second = setup().controller;
    const ids = [first.queueUserMessage('same'), second.queueUserMessage('same')];
    first.clearAllQueues();
    first.replaceMessages([]);
    ids.push(first.queueUserMessage('same'));
    expect(new Set(ids).size).toBe(3);
  });

  it('keeps user protection through turn_start and deletes only exact receipt IDs', () => {
    const { controller, emit } = setup();
    const pending = (controller as unknown as { pendingUserSteering: Set<string> })
      .pendingUserSteering;
    const a = controller.queueUserMessage('same');
    const b = controller.queueUserMessage('same');
    emit({ type: 'turn_start' });
    expect([...pending]).toEqual([a, b]);
    emit({ type: 'steering_accepted', ids: [a, a, 'unknown'] });
    expect([...pending]).toEqual([b]);
    controller.clearAllQueues();
    expect(pending.size).toBe(0);
  });

  it('shares skill-frame activation across visible and legacy steering', () => {
    const { controller } = setup({ skills: { ...DEFAULT_CONFIG.skills, enabled: true } });
    const skills = controller.getSkillService();
    skills.queueFrame('first');
    controller.queueUserMessage('visible');
    skills.queueFrame('second');
    controller.steer('legacy');
    expect(skills.getRegistry().frameNames).toEqual(['first', 'second']);
    expect(skills.getRegistry().pendingFrameNames).toEqual([]);
  });

  it('allocates distinct IDs for identical text and never reuses IDs after reset', () => {
    const { controller, engine } = setup();
    const steer = vi.spyOn(engine, 'steer');
    const a = controller.queueUserMessage('same');
    const b = controller.queueUserMessage('same');
    expect(a).not.toBe(b);
    expect(steer.mock.calls).toEqual([['same', a], ['same', b]]);
    controller.clearAllQueues();
    controller.clearMessages();
    expect(controller.queueUserMessage('same')).not.toBe(a);
    controller.steer('automation');
    expect(steer.mock.calls.at(-1)?.[1]).toEqual(expect.any(String));
  });
});

describe('reviewer and user queue protection through real controller wiring', () => {
  it.each([false, true])('only clears stranded reviewer guidance without pending users: %s',
    async (withUser) => {
      const { controller, engine, emit } = setup({
        fast: { ...DEFAULT_CONFIG.fast, enabled: true, model: 'claude-haiku-4-5',
          reviewEveryTurns: 1 },
        skills: { ...DEFAULT_CONFIG.skills, enabled: true },
      });
      const fast = (controller as unknown as { fast: FastWiring }).fast;
      const registry = (fast as unknown as { getFastRegistry(): ProviderRegistry })
        .getFastRegistry();
      vi.spyOn(registry, 'complete').mockResolvedValue({
        role: 'assistant', content: [{ type: 'text', text: 'Run the pending regression tests.' }],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      vi.spyOn(engine, 'state', 'get').mockReturnValue({ ...engine.state, isRunning: true });
      const steer = vi.spyOn(engine, 'steer');
      const clear = vi.spyOn(engine, 'clearAllQueues');
      emit({ type: 'agent_start' });
      const userId = withUser ? controller.queueUserMessage('do not discard') : undefined;
      for (let turn = 0; turn < 2; turn += 1) {
        emit({ type: 'turn_start' });
        emit({ type: 'turn_end', message: { role: 'assistant', content: [{
          type: 'tool_call', toolCallId: 'read', toolName: 'read_file', args: {},
        }] }, usage: { inputTokens: 1, outputTokens: 1 } });
        if (turn === 1) controller.getSkillService().queueFrame('review-frame');
        emit({ type: 'tool_execution_end', toolCallId: 'read', toolName: 'read_file',
          result: { content: [] }, isError: false, duration: 1 });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(steer.mock.calls.at(-1)).toEqual([expect.stringContaining('<fast_review'), undefined]);
      expect(controller.getSkillService().getRegistry().frameNames).toContain('review-frame');
      controller.setAgentMode('plan');
      emit({ type: 'agent_end', messages: [] });
      expect(clear).toHaveBeenCalledTimes(withUser ? 0 : 1);
      const pending = (controller as unknown as { pendingUserSteering: Set<string> })
        .pendingUserSteering;
      expect([...pending]).toEqual(withUser ? [userId] : []);
    });
});

describe('mounted queue with the real controller', () => {
  it('accepts a late receipt after force-stop without waking the stale run', async () => {
    vi.useFakeTimers();
    const { controller, engine, emit } = setup();
    const state = { ...engine.state, isRunning: false };
    vi.spyOn(engine, 'state', 'get').mockImplementation(() => state);
    const queued = vi.spyOn(controller, 'queueUserMessage');
    const view = render(React.createElement(App, { controller, version: 'test' }));
    const flush = () => vi.advanceTimersByTimeAsync(80);
    try {
      await flush();
      state.isRunning = true;
      emit({ type: 'agent_start' }); await flush();
      view.stdin.write('late receipt'); await flush();
      view.stdin.write('\r'); await flush();
      const id = queued.mock.results[0]?.value as string;
      expect(id).toEqual(expect.any(String));
      expect(view.lastFrame()).toContain('Queue:');
      view.stdin.write('\u001b'); await flush();
      view.stdin.write('\u001b'); await flush();
      view.stdin.write('\u001b'); await flush();
      expect(controller.isRunning()).toBe(true);
      expect(view.lastFrame()).toMatch(/Queue.*已暂停/);
      emit({ type: 'steering_accepted', ids: [id] }); await flush();
      expect(view.lastFrame()).not.toContain('Queue');
      expect(view.lastFrame()).toContain('中断');
      emit({ type: 'turn_start' }); await flush();
      expect(view.lastFrame()).toContain('中断');
    } finally { state.isRunning = false; view.unmount(); }
  });
});
