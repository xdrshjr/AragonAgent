import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import stripAnsi from 'strip-ansi';
import type { AgentEvent } from '@aragon-agent/core';
import type { CompactionEvent } from '../compaction/types.js';
import { AgentController } from '../agent/controller.js';
import { DEFAULT_CONFIG, DEFAULT_SKILLS_RUNTIME, type CliConfig } from '../config/schema.js';
import { App } from '../ui/App.js';
import { createTerminalHarness, settleTerminal } from './helpers/terminal-harness.js';

vi.mock('../config/prompt-history.js', () => ({ loadPromptHistory: () => [],
  appendPrompt: () => [] }));
vi.mock('../config/ui-state.js', () => ({ bumpSubmitCount: () => 1,
  setMouseNoticeVersion: () => {}, setVtInputNoticeVersion: () => {} }));

function fixture() {
  const config = { ...DEFAULT_CONFIG, cwd: process.cwd(), color: false, unicode: false,
    reducedMotion: true, showThinking: true, startInPlanMode: false, submitCount: 20,
    skillsRuntime: DEFAULT_SKILLS_RUNTIME, apiKeys: { anthropic: 'fixture' },
    skills: { ...DEFAULT_CONFIG.skills, enabled: false },
    compaction: { ...DEFAULT_CONFIG.compaction, enabled: false },
    team: { ...DEFAULT_CONFIG.team, enabled: false },
    fast: { ...DEFAULT_CONFIG.fast, enabled: false },
  } as CliConfig;
  const controller = new AgentController(config, { notify: () => {} });
  let receive!: (event: AgentEvent) => void;
  vi.spyOn(controller, 'subscribe').mockImplementation((listener) => {
    receive = listener; return () => {};
  });
  let receiveCompaction!: (event: CompactionEvent) => void;
  vi.spyOn(controller, 'subscribeCompaction').mockImplementation((listener) => {
    receiveCompaction = listener; return () => {};
  });
  return { controller, emit: (event: AgentEvent) => receive(event),
    emitCompaction: (event: CompactionEvent) => receiveCompaction(event) };
}

describe('real Ctrl+G and hidden overlay input', () => {
  it('shows Compact in the primary row when idle receives compaction_start without a snapshot', async () => {
    const terminal = createTerminalHarness();
    const { controller, emitCompaction } = fixture();
    try {
      terminal.mount(<App controller={controller} version="test" />);
      await settleTerminal();
      expect(terminal.lastFrame().trimEnd().split('\n').at(-1)).toContain('Idle');
      emitCompaction({ type: 'compaction_start', trigger: 'manual', index: 1, model: 'fixture' });
      await settleTerminal();
      expect(terminal.lastFrame().trimEnd().split('\n').at(-1)).toContain('Compact');
    } finally { terminal.dispose(); controller.dispose(); }
  });
  it('naturally expires Ctrl+C exit feedback after 1500ms without another key or render trigger', async () => {
    const terminal = createTerminalHarness();
    const { controller } = fixture();
    try {
      terminal.mount(<App controller={controller} version="test" />);
      await settleTerminal();
      terminal.input('retained draft');
      await settleTerminal();
      terminal.input('\x07');
      await settleTerminal();
      terminal.input('\x03');
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('^C exit');
      const armedFrameCount = terminal.frames.length;
      await new Promise(resolve => setTimeout(resolve, 700));
      expect(terminal.lastFrame()).toContain('^C exit');
      await vi.waitFor(() => expect(terminal.lastFrame()).not.toContain('^C exit'),
        { timeout: 1500, interval: 50 });
      expect(terminal.lastFrame()).not.toContain('Press Ctrl+C again to exit');
      expect(terminal.frames.length).toBeGreaterThan(armedFrameCount);
      expect(terminal.lastFrame()).toContain('retained draft');
      expect(terminal.lastFrame()).toContain('^G less');
      expect(terminal.lastFrame().trimEnd().split('\n')).toHaveLength(23);
      // A new press after expiry arms again rather than exiting the application.
      terminal.input('\x03');
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('^C exit');
      expect(terminal.lastFrame()).toContain('retained draft');
    } finally { terminal.dispose(); controller.dispose(); }
  });
  it('expires Esc confirmation in details and removes stopping feedback when the run ends', async () => {
    const terminal = createTerminalHarness(120, 24);
    const { controller, emit } = fixture();
    vi.spyOn(controller, 'abort').mockImplementation(() => {});
    try {
      terminal.mount(<App controller={controller} version="test" />);
      await settleTerminal();
      terminal.input('\x07');
      await settleTerminal();
      emit({ type: 'agent_start' } as AgentEvent);
      await settleTerminal();
      terminal.input('\x1b');
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('Esc again to stop');
      await new Promise(resolve => setTimeout(resolve, 1700));
      await settleTerminal();
      expect(terminal.lastFrame()).not.toContain('Esc again to stop');
      expect(terminal.lastFrame()).toContain('Esc x2 stop');
      terminal.input('\x1b');
      await settleTerminal();
      terminal.input('\x1b');
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('Esc force');
      emit({ type: 'agent_end' } as AgentEvent);
      await settleTerminal();
      const statusRows = terminal.lastFrame().trimEnd().split('\n').slice(-2).join('\n');
      expect(statusRows).not.toMatch(/Esc again|Esc force|Stopping/);
    } finally { terminal.dispose(); controller.dispose(); }
  });
  it('toggles exactly one row without consuming Unicode draft or changing the editor instance', async () => {
    const terminal = createTerminalHarness();
    const { controller } = fixture();
    try {
      terminal.mount(<App controller={controller} version="test" />); await settleTerminal();
      terminal.input('draft-\u4e2d\u6587\u{1f642}'); await settleTerminal();
      const row = () => terminal.lastFrame().split('\n').findIndex(line => line.includes('draft-'));
      expect(row()).toBe(20);
      terminal.input('\x07'); await settleTerminal();
      expect(row()).toBe(19);
      expect(terminal.lastFrame()).toContain('^G less');
      expect(terminal.lastFrame().trimEnd().split('\n')).toHaveLength(23);
      terminal.input('\x07'); await settleTerminal();
      expect(row()).toBe(20);
      terminal.resize(39, 11); await settleTerminal(); await settleTerminal();
      terminal.input('ignored\x07'); await settleTerminal();
      expect(terminal.lastFrame()).toContain('Terminal too small');
      terminal.resize(80, 24); await settleTerminal(); await settleTerminal();
      expect(row()).toBe(20);
      expect(terminal.lastFrame()).toContain('draft-\u4e2d\u6587\u{1f642}');
      expect(terminal.lastFrame()).not.toContain('ignored');
    } finally { terminal.dispose(); controller.dispose(); }
  });
  it('keeps the popup above the editor across detail toggles and draft shrink', async () => {
    const terminal = createTerminalHarness(40, 12);
    const { controller } = fixture();
    try {
      terminal.mount(<App controller={controller} version="test" />); await settleTerminal();
      terminal.input('/'); await settleTerminal();
      expect(terminal.lastFrame().trimEnd().split('\n')).toHaveLength(11);
      terminal.input('\x07'); await settleTerminal();
      expect(terminal.lastFrame().trimEnd().split('\n')).toHaveLength(11);
      terminal.input('\x1b'); await settleTerminal();
      terminal.input('\x7f'); await settleTerminal();
      terminal.input('a\x0ab\x0ac'); await settleTerminal();
      for (const raw of terminal.frames) {
        const frame = stripAnsi(raw);
        if (frame.split('\n').length < 11) continue;
        expect(frame.trimEnd().split('\n')).toHaveLength(11);
      }
      expect(terminal.lastFrame()).toContain('^G less');
    } finally { terminal.dispose(); controller.dispose(); }
  });
  it('keeps confirmation and draft while tiny and ignores y, Enter and Ctrl+G', async () => {
    const terminal = createTerminalHarness(40, 12);
    const { controller } = fixture();
    const bridge: import('../ui/App.js').ConfirmBridge = { handler: null };
    let result: boolean | undefined;
    try {
      terminal.mount(<App controller={controller} version="test" confirmBridge={bridge} />);
      await settleTerminal();
      terminal.input('draft\x0aline2\x0aline3'); await settleTerminal();
      terminal.input('\x07'); await settleTerminal();
      const promise = bridge.handler!({ tool: 'bash', summary: 'first\nsecond\nlast' } as Parameters<NonNullable<typeof bridge.handler>>[0]);
      void promise.then(value => { result = value; });
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('Confirm action');
      expect(terminal.lastFrame()).toContain('y approve');
      terminal.input('\x07'); await settleTerminal();
      expect(terminal.lastFrame()).toContain('Details on');
      terminal.resize(39, 11); await settleTerminal(); await settleTerminal();
      terminal.input('y\r\x07'); await settleTerminal();
      expect(result).toBeUndefined();
      terminal.resize(40, 12); await settleTerminal(); await settleTerminal();
      expect(terminal.lastFrame()).toContain('Confirm action');
      expect(terminal.lastFrame()).toContain('line3');
      terminal.input('\x1b[6~'); await settleTerminal();
      expect(terminal.lastFrame()).toContain('second');
      terminal.input('n'); await settleTerminal();
      expect(result).toBe(false);
      expect(terminal.lastFrame()).toContain('^G less');
    } finally { terminal.dispose(); controller.dispose(); }
  });
});
