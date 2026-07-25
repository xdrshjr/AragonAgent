import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { AgentEvent, ModelInfo } from '@argon-agent/core';

// Keep the app hermetic — never write the developer's real config file.
vi.mock('../config/store.js', () => ({
  updatePersistedConfig: vi.fn(() => ({})),
  getSessionsDir: () => '/tmp/argon-sessions',
  getConfigPath: () => '/tmp/argon-config.json',
}));

const { App } = await import('../ui/App.js');
const { runHeadless } = await import('../agent/headless.js');
import type { AgentController } from '../agent/controller.js';
import type { CliConfig } from '../config/schema.js';
import type { HeadlessController } from '../agent/headless.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MODEL: ModelInfo = {
  id: 'm',
  name: 'M',
  provider: 'anthropic',
  contextWindow: 200_000,
  maxOutputTokens: 8192,
  supportsThinking: true,
  supportsTools: true,
  supportsImages: false,
  cost: { input: 0, output: 0 },
};

const CONFIG: CliConfig = {
  provider: 'anthropic',
  model: 'm',
  baseUrl: undefined,
  thinkingLevel: 'off',
  maxTokens: undefined,
  theme: 'auto',
  reducedMotion: false,
  confirmTools: false,
  toolTimeoutMs: 180_000,
  idleTimeoutMs: 210_000,
  apiKeys: { anthropic: 'k' },
  recentModels: [],
  promptHistory: [],
  cwd: '/work',
  color: true,
  colorLevel: 3,
  unicode: true,
};

class FakeController {
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  aborted = false;
  onPrompt: ((text: string) => Promise<void>) | null = null;

  subscribe(l: (e: AgentEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: AgentEvent): void {
    for (const l of this.listeners) l(e);
  }
  getConfig(): CliConfig {
    return CONFIG;
  }
  hasApiKey(): boolean {
    return true;
  }
  setTheme(): void {}
  getCwd(): string {
    return '/work';
  }
  getModelInfo(): ModelInfo {
    return MODEL;
  }
  getModelRegistry() {
    return { getModel: () => undefined, getModels: () => [] };
  }
  preflight() {
    return { ok: true as const };
  }
  abort(): void {
    this.aborted = true;
  }
  steer(): void {}
  prompt(text: string): Promise<void> {
    return this.onPrompt ? this.onPrompt(text) : Promise.resolve();
  }
}

function mount(fc: FakeController, extra: { initialPrompt?: string } = {}) {
  return render(
    <App
      controller={fc as unknown as AgentController}
      version="0.0.0"
      initialPrompt={extra.initialPrompt}
    />,
  );
}

describe('App (interactive)', () => {
  it('streams assistant text, renders a tool card, and a status bar', async () => {
    const fc = new FakeController();
    fc.onPrompt = async () => {
      fc.emit({ type: 'agent_start' });
      fc.emit({ type: 'turn_start' });
      fc.emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: 'Hello' } });
      fc.emit({ type: 'message_update', streamEvent: { type: 'tool_call_start', toolCallId: 't1', toolName: 'bash' } });
      fc.emit({
        type: 'message_update',
        streamEvent: { type: 'tool_call_end', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } },
      });
      fc.emit({ type: 'turn_end', message: { role: 'assistant', content: [] }, usage: { inputTokens: 100, outputTokens: 20 } });
      fc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: {} });
      fc.emit({
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'ok' }] },
        isError: false,
        duration: 5,
      });
      fc.emit({ type: 'agent_end', messages: [] });
    };

    const { lastFrame, unmount } = mount(fc, { initialPrompt: 'hi' });
    await delay(40);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Hello');
    expect(frame).toContain('bash');
    expect(frame).toContain('anthropic');
    unmount();
  });

  it('routes /help to the help overlay', async () => {
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, { initialPrompt: '/help' });
    await delay(40);
    expect(lastFrame() ?? '').toContain('Help — press Esc to close');
    unmount();
  });

  it('aborts the run on Esc', async () => {
    const fc = new FakeController();
    fc.onPrompt = () =>
      new Promise<void>(() => {
        fc.emit({ type: 'agent_start' });
        fc.emit({ type: 'turn_start' });
      });
    const { stdin, unmount } = mount(fc, { initialPrompt: 'go' });
    await delay(40);
    stdin.write('\u001B'); // Esc key (escape)
    await delay(40);
    expect(fc.aborted).toBe(true);
    unmount();
  });

  it('renders the Welcome card and a context gauge on an empty session', async () => {
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc);
    await delay(40);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Welcome to ArgonAgent');
    expect(frame).toContain('%'); // status-bar context gauge
    unmount();
  });

  it('renders a sign-prefixed diff for an edit_file tool', async () => {
    const fc = new FakeController();
    fc.onPrompt = async () => {
      fc.emit({ type: 'agent_start' });
      fc.emit({ type: 'turn_start' });
      fc.emit({ type: 'message_update', streamEvent: { type: 'tool_call_start', toolCallId: 't1', toolName: 'edit_file' } });
      fc.emit({
        type: 'message_update',
        streamEvent: { type: 'tool_call_end', toolCallId: 't1', toolName: 'edit_file', args: { path: 'a.ts' } },
      });
      fc.emit({ type: 'turn_end', message: { role: 'assistant', content: [] }, usage: { inputTokens: 1, outputTokens: 1 } });
      fc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'edit_file', args: {} });
      fc.emit({
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'edit_file',
        result: { content: [{ type: 'text', text: 'Applied edit to a.ts:\n--- a.ts\n+++ a.ts\n- old line\n+ new line' }] },
        isError: false,
        duration: 3,
      });
      fc.emit({ type: 'agent_end', messages: [] });
    };
    const { lastFrame, unmount } = mount(fc, { initialPrompt: 'edit it' });
    await delay(40);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('- old line');
    expect(frame).toContain('+ new line');
    unmount();
  });

  it('expands the most recent tool card on Ctrl+O', async () => {
    const fc = new FakeController();
    const longText = Array.from({ length: 12 }, (_, i) => `L${i + 1}`).join('\n');
    fc.onPrompt = async () => {
      fc.emit({ type: 'agent_start' });
      fc.emit({ type: 'turn_start' });
      fc.emit({ type: 'message_update', streamEvent: { type: 'tool_call_start', toolCallId: 't1', toolName: 'read_file' } });
      fc.emit({
        type: 'message_update',
        streamEvent: { type: 'tool_call_end', toolCallId: 't1', toolName: 'read_file', args: { path: 'a.txt' } },
      });
      fc.emit({ type: 'turn_end', message: { role: 'assistant', content: [] }, usage: { inputTokens: 1, outputTokens: 1 } });
      fc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read_file', args: {} });
      fc.emit({
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'read_file',
        result: { content: [{ type: 'text', text: longText }] },
        isError: false,
        duration: 3,
      });
      fc.emit({ type: 'agent_end', messages: [] });
    };
    const { lastFrame, stdin, unmount } = mount(fc, { initialPrompt: 'read it' });
    await delay(40);
    expect(lastFrame() ?? '').toContain('+4'); // "… +4 lines (Ctrl+O)" collapsed footer
    stdin.write(''); // Ctrl+O
    await delay(40);
    expect(lastFrame() ?? '').toContain('L12'); // full preview now visible
    unmount();
  });

  it('shows a transient toast for a slash-command ack', async () => {
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, { initialPrompt: '/theme dark' });
    await delay(40);
    expect(lastFrame() ?? '').toContain('Theme set to dark');
    unmount();
  });
});

describe('headless mode', () => {
  it('streams text to stdout and resolves exit 0', async () => {
    const listeners: ((e: AgentEvent) => void)[] = [];
    const emit = (e: AgentEvent) => listeners.forEach((l) => l(e));
    const captured: string[] = [];
    const stdout = {
      write: (s: string) => {
        captured.push(s);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const stub: HeadlessController = {
      preflight: () => ({ ok: true }),
      subscribe: (l) => {
        listeners.push(l);
        return () => {};
      },
      getModelInfo: () => MODEL,
      prompt: async () => {
        emit({ type: 'agent_start' });
        emit({ type: 'turn_start' });
        emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: 'Hello world' } });
        emit({ type: 'turn_end', message: { role: 'assistant', content: [] }, usage: { inputTokens: 1, outputTokens: 2 } });
        emit({ type: 'agent_end', messages: [] });
      },
    };

    const code = await runHeadless(stub, 'hi', { stdout, quiet: true });
    expect(code).toBe(0);
    expect(captured.join('')).toBe('Hello world\n');
  });

  it('returns exit 2 on a pre-flight config error', async () => {
    const stub: HeadlessController = {
      preflight: () => ({ ok: false, kind: 'config', message: 'no key' }),
      subscribe: () => () => {},
      getModelInfo: () => MODEL,
      prompt: async () => {},
    };
    const stderr = { write: () => true } as unknown as NodeJS.WritableStream;
    const code = await runHeadless(stub, 'hi', { stderr, quiet: true });
    expect(code).toBe(2);
  });
});
