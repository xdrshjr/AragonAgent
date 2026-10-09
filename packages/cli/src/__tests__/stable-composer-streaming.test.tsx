import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@aragon-agent/core';
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
    renderGovernor: false, reducedMotion: true, showThinking: true, startInPlanMode: false, submitCount: 20,
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
  return { controller, emit: (event: AgentEvent) => receive(event) };
}

describe('fixed composer in real App frames', () => {
  it('preserves every character when a burst of deltas is coalesced', async () => {
    const terminal = createTerminalHarness();
    const { controller, emit } = fixture();
    try {
      terminal.mount(<App controller={controller} version="test" />);
      await settleTerminal();
      expect(terminal.layoutFrames.length).toBeGreaterThan(0);
      for (const frame of terminal.layoutFrames) expect(frame.trimEnd().split('\n')).toHaveLength(23);
      terminal.input('stable-draft'); await settleTerminal();
      emit({ type: 'agent_start' });
      emit({ type: 'turn_start' });
      const text = 'Burst Unicode \u4e2d\u6587 \u{1f642}: all characters survive.';
      const before = terminal.layoutFrames.length;
      for (const delta of text) emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta } });
      await settleTerminal(); await settleTerminal();
      expect(terminal.lastFrame()).toContain(text);
      for (const raw of terminal.layoutFrames.slice(before)) {
        const lines = raw.trimEnd().split('\n');
        expect(lines).toHaveLength(23);
        expect(lines[20]).toContain('stable-draft');
        expect(lines[19]).toMatch(/[-─]/);
        expect(lines[21]).toMatch(/[-─]/);
      }
    } finally { terminal.dispose(); controller.dispose(); }
  });
  it.each(['text_delta', 'thinking_delta'] as const)('keeps every observed %s frame fixed', async kind => {
    const terminal = createTerminalHarness();
    const { controller, emit } = fixture();
    try {
      terminal.mount(<App controller={controller} version="test" />);
      await settleTerminal();
      expect(terminal.layoutFrames.length).toBeGreaterThan(0);
      for (const frame of terminal.layoutFrames) expect(frame.trimEnd().split('\n')).toHaveLength(23);
      terminal.input('stable-draft'); await settleTerminal();
      const draftRow = terminal.lastFrame().split('\n').findIndex((row) => row.includes('stable-draft'));
      expect(draftRow).toBe(20);
      const baselineFrame = terminal.layoutFrames.length;
      emit({ type: 'agent_start' });
      emit({ type: 'turn_start' });
      if (kind === 'thinking_delta') emit({ type: 'message_update', streamEvent: { type: 'thinking_start' } });
      await settleTerminal();
      let changes = 0;
      let previous = terminal.lastFrame().split('\n').slice(1, 19).join('\n');
      for (let n = 1; n <= 300; n++) {
        const before = terminal.layoutFrames.length;
        emit({ type: 'message_update', streamEvent: { type: kind, delta: `visible output ${n}\n` } });
        for (let attempt = 0; attempt < 20; attempt++) {
          await settleTerminal();
          const body = terminal.lastFrame().split('\n').slice(1, 19).join('\n');
          if (body !== previous && body.includes(`visible output ${n}`)) break;
        }
        for (const raw of terminal.layoutFrames.slice(before)) {
          const frame = raw;
          expect(frame).toContain('stable-draft');
          const body = frame.split('\n').slice(1, 19).join('\n');
          if (body !== previous) { changes++; previous = body; }
          expect(frame.trimEnd().split('\n')).toHaveLength(23);
          expect(frame.split('\n').findIndex((row) => row.includes('stable-draft'))).toBe(draftRow);
          expect(frame.split('\n')[draftRow - 1]).toMatch(/[-─]/);
          expect(frame.split('\n')[draftRow + 1]).toMatch(/[-─]/);
        }
      }
      expect(changes).toBeGreaterThanOrEqual(300);
      expect(terminal.lastFrame()).toContain('visible output 300');
      for (const frame of terminal.layoutFrames.slice(baselineFrame)) {
        const lines = frame.trimEnd().split('\n');
        expect(lines).toHaveLength(23);
        expect(lines[draftRow]).toContain('stable-draft');
        expect(lines[draftRow - 1]).toMatch(/[-─]/);
        expect(lines[draftRow + 1]).toMatch(/[-─]/);
      }
    } finally { terminal.dispose(); controller.dispose(); }
  }, 180000);
});
