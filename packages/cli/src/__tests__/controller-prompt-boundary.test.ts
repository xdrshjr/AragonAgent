import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@aragon-agent/core';
import { AgentController } from '../agent/controller.js';
import { DEFAULT_CONFIG, DEFAULT_SKILLS_RUNTIME, type CliConfig } from '../config/schema.js';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../ui/App.js';

const controllers: AgentController[] = [];
const items = ['one', 'two', 'three'].map((content) => ({ content, status: 'pending' }));

function setup() {
  const config = {
    ...DEFAULT_CONFIG, cwd: process.cwd(), color: true, unicode: true, submitCount: 0,
    startInPlanMode: false, skillsRuntime: DEFAULT_SKILLS_RUNTIME,
    skills: { ...DEFAULT_CONFIG.skills, enabled: false },
    compaction: { ...DEFAULT_CONFIG.compaction, enabled: false },
    team: { ...DEFAULT_CONFIG.team, enabled: false },
    fast: { ...DEFAULT_CONFIG.fast, enabled: false },
    apiKeys: { anthropic: 'test' },
  } as CliConfig;
  const notify = vi.fn();
  const controller = new AgentController(config, { notify });
  controllers.push(controller);
  controller.restoreTodos(items);
  const engine = (controller as unknown as { agent: Agent }).agent;
  const prompt = vi.spyOn(engine, 'prompt').mockResolvedValue(undefined);
  return { controller, engine, prompt, notify };
}

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('prompt startup boundary', () => {
  it('a newer prompt invalidates the older pending message', async () => {
    const { controller, engine, prompt } = setup();
    const state = { ...engine.state, isRunning: true };
    vi.spyOn(engine, 'state', 'get').mockImplementation(() => state);
    let release!: () => void;
    vi.spyOn(engine, 'waitForIdle').mockReturnValue(new Promise<void>((r) => { release = r; }));
    const old = controller.prompt('old', { todoPolicy: 'new-task' });
    const latest = controller.prompt('latest', { todoPolicy: 'new-task' });
    state.isRunning = false;
    release();
    expect(await old).toEqual({ status: 'not-started', reason: 'cancelled' });
    expect(await latest).toEqual({ status: 'finished' });
    expect(prompt).toHaveBeenCalledExactlyOnceWith('latest');
  });

  it('preserves cancellation issued synchronously by an engine abort listener', async () => {
    const { controller, engine, prompt } = setup();
    const state = { ...engine.state, isRunning: true };
    vi.spyOn(engine, 'state', 'get').mockImplementation(() => state);
    vi.spyOn(engine, 'waitForIdle').mockResolvedValue(undefined);
    const abort = vi.spyOn(engine, 'abort').mockImplementationOnce(() => {
      controller.abort();
      state.isRunning = false;
    });
    const before = controller.getTodoSnapshot();
    expect(await controller.prompt('cancelled', { todoPolicy: 'new-task' }))
      .toEqual({ status: 'not-started', reason: 'cancelled' });
    expect(abort).toHaveBeenCalledTimes(2);
    expect(prompt).not.toHaveBeenCalled();
    expect(controller.getTodoSnapshot()).toEqual(before);
  });

  it('clears the real store before entering the new engine prompt', async () => {
    const { controller, prompt } = setup();
    prompt.mockImplementation(async () => { expect(controller.getTodoSnapshot()).toBeNull(); });
    expect(await controller.prompt('new', { todoPolicy: 'new-task' }))
      .toEqual({ status: 'finished' });
  });

  it('continuation and steering preserve the real store', async () => {
    const { controller } = setup();
    const before = controller.getTodoSnapshot();
    await controller.prompt('continue', { todoPolicy: 'continue' });
    controller.steer('keep going');
    expect(controller.getTodoSnapshot()).toEqual(before);
  });

  it('retains legacy behavior when options are absent', async () => {
    const { controller } = setup();
    const before = controller.getTodoSnapshot();
    await controller.prompt('legacy');
    expect(controller.getTodoSnapshot()).toEqual(before);
  });

  it('times out without clearing TODOs or entering the busy engine', async () => {
    vi.useFakeTimers();
    const { controller, engine, prompt, notify } = setup();
    vi.spyOn(engine, 'state', 'get').mockReturnValue({ ...engine.state, isRunning: true });
    vi.spyOn(engine, 'waitForIdle').mockReturnValue(new Promise(() => {}));
    const before = controller.getTodoSnapshot();
    const result = controller.prompt('new', { todoPolicy: 'new-task' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toEqual({ status: 'not-started', reason: 'failed' });
    expect(prompt).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(controller.getTodoSnapshot()).toEqual(before);
  });

  it.each(['abort', 'forceStop', 'clearMessages', 'replaceMessages'] as const)(
    '%s invalidates a pending startup before its idle wait resolves', async (method) => {
      const { controller, engine, prompt, notify } = setup();
      const state = { ...engine.state, isRunning: true };
      vi.spyOn(engine, 'state', 'get').mockImplementation(() => state);
      let release!: () => void;
      vi.spyOn(engine, 'waitForIdle').mockReturnValue(new Promise<void>((r) => { release = r; }));
      const result = controller.prompt('cancel me', { todoPolicy: 'new-task' });
      state.isRunning = false;
      if (method === 'replaceMessages') controller.replaceMessages([]);
      else controller[method]();
      const afterCancel = controller.getTodoSnapshot();
      release();
      expect(await result).toEqual({ status: 'not-started', reason: 'cancelled' });
      expect(prompt).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(controller.getTodoSnapshot()).toEqual(afterCancel);
      expect(await controller.prompt('next', { todoPolicy: 'new-task' }))
        .toEqual({ status: 'finished' });
      expect(prompt).toHaveBeenCalledExactlyOnceWith('next');
    },
  );
});

const flush = async () => { await vi.advanceTimersByTimeAsync(80); };
const ESC = '\u001b';

describe('mounted App with the real pending-start controller', () => {
  it('a late cancelled outcome cannot end the newer pending submission', async () => {
    vi.useFakeTimers();
    const { controller, engine, prompt } = setup();
    const state = { ...engine.state, isRunning: false };
    vi.spyOn(engine, 'state', 'get').mockImplementation(() => state);
    const releases: Array<() => void> = [];
    vi.spyOn(engine, 'waitForIdle').mockImplementation(() =>
      new Promise<void>((resolve) => { releases.push(resolve); }));
    const view = render(React.createElement(App, { controller, version: 'test',  }));
    try {
      await flush();
      state.isRunning = true;
      view.stdin.write('first'); await flush(); view.stdin.write('\r'); await flush();
      view.stdin.write(ESC); await flush(); view.stdin.write(ESC); await flush();
      view.stdin.write('second'); await flush(); view.stdin.write('\r'); await flush();
      releases[0]!(); await flush();
      view.stdin.write('third'); await flush(); view.stdin.write('\r'); await flush();
      expect(view.lastFrame()).toContain('A run is still starting.');
      expect(releases).toHaveLength(2);
      view.stdin.write(ESC); await flush(); view.stdin.write(ESC); await flush();
      expect(view.lastFrame()).toContain('Pending run cancelled.');
      state.isRunning = false;
      releases[1]!(); await flush();
      expect(prompt).not.toHaveBeenCalled();
    } finally { view.unmount(); }
  });

  it('reset while starting cancels startup and synchronizes the idle view', async () => {
    vi.useFakeTimers();
    const { controller, engine, prompt } = setup();
    const state = { ...engine.state, isRunning: false };
    vi.spyOn(engine, 'state', 'get').mockImplementation(() => state);
    let release!: () => void;
    vi.spyOn(engine, 'waitForIdle').mockReturnValue(new Promise<void>((r) => { release = r; }));
    const view = render(React.createElement(App, { controller, version: 'test',  }));
    try {
      await flush();
      state.isRunning = true;
      view.stdin.write('old request'); await flush();
      view.stdin.write('\r'); await flush();
      view.stdin.write('/reset'); await flush();
      view.stdin.write('\r'); await flush();
      expect(view.lastFrame()).toContain('idle');
      expect(view.frames.join('\n')).not.toContain('The run ended without producing a response');
      state.isRunning = false;
      release(); await flush();
      expect(prompt).not.toHaveBeenCalled();
      view.stdin.write('new conversation'); await flush();
      view.stdin.write('\r'); await flush();
      expect(prompt).toHaveBeenCalledExactlyOnceWith('new conversation');
    } finally { view.unmount(); }
  });

  it('two ESC events cancel startup, reject steering, and retain the old plan', async () => {
    vi.useFakeTimers();
    const { controller, engine, prompt, notify } = setup();
    const state = { ...engine.state, isRunning: false };
    vi.spyOn(engine, 'state', 'get').mockImplementation(() => state);
    let release!: () => void;
    vi.spyOn(engine, 'waitForIdle').mockReturnValue(new Promise<void>((r) => { release = r; }));
    const steer = vi.spyOn(controller, 'steer');
    const before = controller.getTodoSnapshot();
    const view = render(React.createElement(App, { controller, version: 'test',  }));
    try {
      await flush();
      // The view is idle after a force-stop, but the old engine is still unwinding.
      state.isRunning = true;
      view.stdin.write('cancel me'); await flush();
      view.stdin.write('\r'); await flush();
      view.stdin.write('do not steer'); await flush();
      view.stdin.write('\r'); await flush();
      expect(steer).not.toHaveBeenCalled();
      expect(view.lastFrame()).toContain('A run is still starting.');
      view.stdin.write(ESC); await flush();
      view.stdin.write(ESC); await flush();
      expect(view.lastFrame()).toContain('Pending run cancelled.');
      expect(controller.getTodoSnapshot()).toEqual(before);
      state.isRunning = false;
      release(); await flush();
      expect(prompt).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      view.stdin.write('next'); await flush();
      view.stdin.write('\r'); await flush();
      expect(prompt).toHaveBeenCalledExactlyOnceWith('next');
      expect(controller.getTodoSnapshot()).toBeNull();
    } finally { view.unmount(); }
  });

  it('startup timeout returns the App to idle without synthesizing agent_end', async () => {
    vi.useFakeTimers();
    const { controller, engine, prompt, notify } = setup();
    const state = { ...engine.state, isRunning: false };
    vi.spyOn(engine, 'state', 'get').mockImplementation(() => state);
    vi.spyOn(engine, 'waitForIdle').mockReturnValue(new Promise(() => {}));
    const ends = vi.fn();
    controller.subscribe((event) => { if (event.type === 'agent_end') ends(); });
    const view = render(React.createElement(App, { controller, version: 'test',  }));
    try {
      await flush();
      state.isRunning = true;
      view.stdin.write('timeout'); await flush();
      view.stdin.write('\r'); await flush();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(view.lastFrame()).toContain('idle');
      expect(notify).toHaveBeenCalledTimes(1);
      expect(ends).not.toHaveBeenCalled();
      expect(controller.getTodoSnapshot()).not.toBeNull();
      state.isRunning = false;
      view.stdin.write('retry'); await flush();
      view.stdin.write('\r'); await flush();
      expect(prompt).toHaveBeenCalledExactlyOnceWith('retry');
    } finally { view.unmount(); }
  });

  it('unmount cancels the pending request before its wait can finish', async () => {
    vi.useFakeTimers();
    const { controller, engine, prompt } = setup();
    const state = { ...engine.state, isRunning: false };
    vi.spyOn(engine, 'state', 'get').mockImplementation(() => state);
    let release!: () => void;
    vi.spyOn(engine, 'waitForIdle').mockReturnValue(new Promise<void>((r) => { release = r; }));
    const before = controller.getTodoSnapshot();
    const view = render(React.createElement(App, { controller, version: 'test',  }));
    await flush();
    state.isRunning = true;
    view.stdin.write('cancel on unmount'); await flush();
    view.stdin.write('\r'); await flush();
    view.unmount(); await flush();
    state.isRunning = false;
    release(); await flush();
    expect(prompt).not.toHaveBeenCalled();
    expect(controller.getTodoSnapshot()).toEqual(before);
  });
});
