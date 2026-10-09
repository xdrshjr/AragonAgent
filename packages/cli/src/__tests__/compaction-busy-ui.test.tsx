import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Agent, Message } from '@aragon-agent/core';
import { AgentController } from '../agent/controller.js';
import { CompactionWiring } from '../compaction/wiring.js';
import { DEFAULT_CONFIG, DEFAULT_SKILLS_RUNTIME, type CliConfig } from '../config/schema.js';
import { App } from '../ui/App.js';

const controllers: AgentController[] = [];
function setup() {
  const config = {
    ...DEFAULT_CONFIG, cwd: process.cwd(), color: true, unicode: true, submitCount: 0,
    startInPlanMode: false, skillsRuntime: DEFAULT_SKILLS_RUNTIME,
    skills: { ...DEFAULT_CONFIG.skills, enabled: false },
    compaction: { ...DEFAULT_CONFIG.compaction, enabled: true },
    team: { ...DEFAULT_CONFIG.team, enabled: false },
    fast: { ...DEFAULT_CONFIG.fast, enabled: false }, apiKeys: { anthropic: 'test' },
  } as CliConfig;
  const controller = new AgentController(config, { notify: vi.fn() });
  controllers.push(controller);
  const engine = (controller as unknown as { agent: Agent }).agent;
  const original: Message[] = [{ role: 'user', content: 'original', timestamp: 1 }];
  controller.replaceMessages(original);
  let finish!: () => void;
  let captured: Parameters<CompactionWiring['compactNow']>[0];
  vi.spyOn(CompactionWiring.prototype, 'compactNow').mockImplementation(async (input) => {
    captured = input;
    // Model the real wiring's local cancellation race, including its settlement.
    await new Promise<void>((resolve) => {
      finish = resolve;
      input.signal.addEventListener('abort', resolve as () => void, { once: true });
      if (input.signal.aborted) resolve();
    });
    const boundary = input as typeof input & { isCurrent(): boolean; adopt(messages: Message[]): void };
    if (input.signal.aborted) return { ok: false, reason: 'aborted' };
    if (!boundary.isCurrent()) return { ok: false, reason: 'stale_history' };
    const messages: Message[] = [{ role: 'user', content: 'adopted', timestamp: 2 }];
    boundary.adopt(messages);
    return { ok: true, messages };
  });
  return { controller, engine, original, finish: () => finish(), getFinish: () => finish,
    signal: () => captured.signal };
}

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('idle compaction ownership', () => {
  it('locks synchronously, rejects a second compact and prompt, and adopts exactly once', async () => {
    const { controller, engine, finish } = setup();
    const notify = vi.fn();
    controller.subscribeCompactionBusy(notify);
    const prompt = vi.spyOn(engine, 'prompt');
    const replace = vi.spyOn(engine, 'replaceMessages');
    const operation = controller.compactNow();
    expect(controller.isCompactionBusy()).toBe(true);
    expect(notify).toHaveBeenCalledWith(true);
    expect(await controller.compactNow()).toEqual({ ok: false, reason: 'busy' });
    expect(await controller.prompt('preserve me')).toEqual({ status: 'not-started', reason: 'failed' });
    expect(prompt).not.toHaveBeenCalled();
    finish();
    expect(await operation).toEqual({ ok: true });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls).toEqual([[true], [false]]);
  });

  it('abort releases busy without awaiting an uncooperative transport', async () => {
    const { controller, original, finish, signal } = setup();
    const operation = controller.compactNow();
    controller.abort();
    expect(signal().aborted).toBe(true);
    expect(await operation).toEqual({ ok: false, reason: 'aborted' });
    expect(controller.isCompactionBusy()).toBe(false);
    expect(controller.getMessages()).toEqual(original);
    finish();
    await Promise.resolve();
    expect(controller.getMessages()).toEqual(original);
  });

  it('cancellation after the adoption boundary cannot report adopted history as failed', async () => {
    const { controller, engine, finish } = setup();
    const replace = engine.replaceMessages.bind(engine);
    vi.spyOn(engine, 'replaceMessages').mockImplementation((messages) => {
      replace(messages);
      controller.abort();
    });
    const operation = controller.compactNow();
    finish();
    expect(await operation).toEqual({ ok: true });
    expect(controller.getMessages()[0]).toMatchObject({ content: 'adopted' });
  });

  it('replacing history prevents a late candidate from overwriting the new conversation', async () => {
    const { controller, finish } = setup();
    const operation = controller.compactNow();
    controller.replaceMessages([{ role: 'user', content: 'resumed', timestamp: 3 }]);
    finish();
    expect((await operation).ok).toBe(false);
    expect(controller.getMessages()[0]).toMatchObject({ content: 'resumed' });
  });

  it('a settings change cancels an uncooperative summarizer immediately', async () => {
    const { controller, original } = setup();
    const operation = controller.compactNow();
    controller.setMaxTokens(1234);
    expect(await operation).toEqual({ ok: false, reason: 'aborted' });
    expect(controller.isCompactionBusy()).toBe(false);
    expect(controller.getMessages()).toEqual(original);
  });

  it('the local hard deadline releases ownership and reports timeout', async () => {
    vi.useFakeTimers();
    const { controller, original } = setup();
    const operation = controller.compactNow();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await operation).toEqual({ ok: false, reason: 'timeout' });
    expect(controller.isCompactionBusy()).toBe(false);
    expect(controller.getMessages()).toEqual(original);
  });

  it('a live system prompt change invalidates idle compaction immediately', async () => {
    const { controller, signal } = setup();
    const operation = controller.compactNow();
    controller.setAgentMode('plan');
    expect(signal().aborted).toBe(true);
    expect(await operation).toEqual({ ok: false, reason: 'aborted' });
  });

  it('continue refuses to enter the engine while local compaction owns history', async () => {
    const { controller, engine } = setup();
    const resume = vi.spyOn(engine, 'continue');
    const operation = controller.compactNow();
    expect(await controller.continue()).toEqual({ status: 'not-started', reason: 'failed' });
    expect(resume).not.toHaveBeenCalled();
    controller.abort();
    await operation;
  });

  it('a late cancelled operation cannot release the next operation lock', async () => {
    const { controller, finish, getFinish } = setup();
    const first = controller.compactNow();
    const finishFirst = getFinish();
    const callback = vi.mocked(CompactionWiring.prototype.compactNow).mock.calls[0]![0];
    await controller.cancelCompaction();
    await first;
    const second = controller.compactNow();
    expect(controller.isCompactionBusy()).toBe(true);
    expect(callback.isCurrent!()).toBe(false);
    finishFirst();
    await Promise.resolve();
    expect(controller.isCompactionBusy()).toBe(true);
    finish();
    await second;
    expect(controller.getMessages()[0]).toMatchObject({ content: 'adopted' });
  });
});

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await vi.advanceTimersByTimeAsync(30);
  }
}

describe('compaction input queue', () => {
  it('reset cancels compaction and clears queued input before any drain can start', async () => {
    vi.useFakeTimers();
    const { controller, engine } = setup();
    const resume = vi.spyOn(engine, 'continue').mockResolvedValue(undefined);
    const view = render(<App controller={controller} version="test" />);
    try {
      await flush();
      const operation = controller.compactNow();
      view.stdin.write('old queued task'); await flush();
      view.stdin.write('\r'); await flush();
      view.stdin.write('/reset'); await flush();
      view.stdin.write('\r'); await flush();
      await operation;
      expect(resume).not.toHaveBeenCalled();
      expect(controller.getMessages()).toEqual([]);
      expect(controller.hasPendingUserMessages()).toBe(false);
    } finally { view.unmount(); }
  });

  it('retains busy input in the existing queue and drains once on release', async () => {
    vi.useFakeTimers();
    const { controller, engine, finish } = setup();
    const prompt = vi.spyOn(engine, 'prompt').mockResolvedValue(undefined);
    const resume = vi.spyOn(engine, 'continue').mockResolvedValue(undefined);
    const queue = vi.spyOn(controller, 'queueUserMessage');
    const view = render(<App controller={controller} version="test" />);
    try {
      await flush();
      const operation = controller.compactNow();
      view.stdin.write('keep this input'); await flush();
      view.stdin.write('\r'); await flush();
      expect(queue).toHaveBeenCalledExactlyOnceWith('keep this input');
      expect(prompt).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      finish();
      await operation; await flush();
      expect(resume).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); }
  });

  it('Esc cancels idle compaction even without a Core run', async () => {
    vi.useFakeTimers();
    const { controller } = setup();
    const view = render(<App controller={controller} version="test" />);
    try {
      await flush();
      const operation = controller.compactNow();
      view.stdin.write('\x1b'); await flush();
      expect(controller.isCompactionBusy()).toBe(false);
      expect(await operation).toEqual({ ok: false, reason: 'aborted' });
    } finally { view.unmount(); }
  });
});
