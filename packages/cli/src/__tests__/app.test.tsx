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
const { frameHeight } = await import('../ui/layout/frame.js');
import type { AgentController } from '../agent/controller.js';
import { DEFAULT_SKILLS_CONFIG, DEFAULT_SKILLS_RUNTIME, type CliConfig } from '../config/schema.js';
import type { SkillService } from '../skills/service.js';
import type { HeadlessController } from '../agent/headless.js';
import type { RenderMode } from '../ui/layout/frame.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The gradient wordmark colors every character separately, so assertions on
 *  brand text have to look at the plain glyphs. */
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

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
  exitTranscript: true,
  transcriptWindow: 300,
  toolTimeoutMs: 180_000,
  idleTimeoutMs: 210_000,
  apiKeys: { anthropic: 'k' },
  recentModels: [],
  promptHistory: [],
  density: 'comfortable',
  hints: true,
  submitCount: 0,
  skills: DEFAULT_SKILLS_CONFIG,
  skillsRuntime: DEFAULT_SKILLS_RUNTIME,
  cwd: '/work',
  color: true,
  colorLevel: 3,
  unicode: true,
};

/**
 * The narrow slice of `SkillService` the App touches while mounting: command
 * registration reads `list()`, the trust-gate effect reads `untrustedDirs()`.
 * Kept as a stub rather than a real service so these tests never touch the
 * developer's actual skills directory.
 */
const EMPTY_SKILL_SERVICE = {
  list: () => [],
  untrustedDirs: () => [],
  getRegistry: () => ({ activeNames: [] as string[] }),
} as unknown as SkillService;

class FakeController {
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  aborted = false;
  onPrompt: ((text: string) => Promise<void>) | null = null;
  config: CliConfig = CONFIG;

  subscribe(l: (e: AgentEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: AgentEvent): void {
    for (const l of this.listeners) l(e);
  }
  getConfig(): CliConfig {
    return this.config;
  }
  hasApiKey(): boolean {
    return true;
  }
  setTheme(): void {}
  setSubmitCount(n: number): void {
    this.config = { ...this.config, submitCount: n };
  }
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
  getSkillService(): SkillService {
    return EMPTY_SKILL_SERVICE;
  }
  setOnSkillsChanged(): void {}
}

function mount(fc: FakeController, extra: { initialPrompt?: string; mode?: RenderMode } = {}) {
  return render(
    <App
      controller={fc as unknown as AgentController}
      version="0.0.0"
      mode={extra.mode ?? 'inline'}
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
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Help');
    expect(frame).toContain('Keybindings');
    expect(frame).toContain('Esc close');
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

  it('renders the session opener and a context gauge on an empty session', async () => {
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc);
    await delay(40);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Full permission, no sandbox');
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
    expect(lastFrame() ?? '').toContain('+4'); // "+4 lines (Ctrl+O)" collapsed footer
    stdin.write(''); // Ctrl+O
    await delay(40);
    expect(lastFrame() ?? '').toContain('L12'); // full preview now visible
    unmount();
  });

  it('shows a transient toast for a slash-command ack', async () => {
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, { initialPrompt: '/theme cool' });
    await delay(40);
    expect(lastFrame() ?? '').toContain('Theme set to cool');
    unmount();
  });
});

describe('App (fullscreen frame)', () => {
  // `mode` MUST be passed explicitly. `ink-testing-library`'s stdout stub has no
  // `isTTY` (its `class Stdout` exposes only a `columns` getter), so
  // `decideRenderMode` would return 'inline' forever and this whole block would
  // silently be testing the fallback path instead of the frame it claims to.
  it('pins the composer and status bar to the bottom of a fixed-height frame (R2)', async () => {
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(60);

    const lines = (lastFrame() ?? '').split('\n');
    // The stub reports no `rows`, so the frame falls back to 24 → height 23.
    expect(lines).toHaveLength(frameHeight(undefined));
    expect(lines).toHaveLength(23);

    // Row 1 always carries the brand (R1).
    expect(stripAnsi(lines[0] ?? '')).toContain('◇');
    expect(stripAnsi(lines[0] ?? '')).toContain('ArgonAgent');
    // The status bar is literally the last row of the frame.
    expect(stripAnsi(lines[lines.length - 1] ?? '')).toMatch(/idle/);
    // The composer sits directly above it, inside the last 5 rows.
    expect(stripAnsi(lines.slice(-5, -2).join('\n'))).toContain('❯');
    unmount();
  });

  it('keeps the frame strictly shorter than the terminal (invariant I-1)', async () => {
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(60);
    const lines = (lastFrame() ?? '').split('\n');
    expect(lines.length).toBeLessThan(24);
    unmount();
  });

  it('does not recall prompt history on Shift+Up (the viewport owns it)', async () => {
    const fc = new FakeController();
    fc.config = { ...CONFIG, promptHistory: ['a remembered prompt'] };
    const { lastFrame, stdin, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(60);

    stdin.write('[1;2A'); // Shift+Up
    await delay(40);
    expect(lastFrame() ?? '').not.toContain('a remembered prompt');

    stdin.write('[A'); // plain Up still recalls
    await delay(40);
    expect(lastFrame() ?? '').toContain('a remembered prompt');
    unmount();
  });

  it('repaints on Ctrl+L instead of leaving a blank screen (I-5)', async () => {
    const fc = new FakeController();
    const { lastFrame, frames, stdin, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(60);

    const before = frames.length;
    const previous = lastFrame();
    stdin.write('\f'); // Ctrl+L
    await delay(60);

    expect(frames.length).toBe(before + 1);
    const repaint = lastFrame() ?? '';
    expect(repaint.length).toBeGreaterThan(0);
    // Not merely "a frame happened": the bytes must differ, or Ink's two dedupe
    // gates (ink.js:132 + log-update.js:13) would have swallowed the repaint.
    expect(repaint).not.toBe(previous);
    // …and the change must be invisible: same rows, same trimmed content.
    expect(repaint.split('\n')).toHaveLength((previous ?? '').split('\n').length);
    unmount();
  });

  it('actually scrolls when the content overflows the viewport (invariant I-2)', async () => {
    // This is the behavioral form of the `flexShrink={0}` assertion: drop it and
    // yoga squeezes the content to the viewport height, `measureElement` reports
    // content === viewport, overflow is permanently 0, and PgUp becomes a silent
    // no-op. Nothing throws — the frame simply stops moving.
    const fc = new FakeController();
    const long = Array.from({ length: 60 }, (_, i) => `LINE${i + 1}`).join('\n');
    fc.onPrompt = async () => {
      fc.emit({ type: 'agent_start' });
      fc.emit({ type: 'turn_start' });
      fc.emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: long } });
      fc.emit({
        type: 'turn_end',
        message: { role: 'assistant', content: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      fc.emit({ type: 'agent_end', messages: [] });
    };

    const { lastFrame, stdin, unmount } = mount(fc, { mode: 'fullscreen', initialPrompt: 'go' });
    await delay(120);

    const pinned = stripAnsi(lastFrame() ?? '');
    expect(pinned).toContain('LINE60'); // pinned to the newest output
    expect(pinned).not.toMatch(/↑\d/); // …so no off-bottom indicator yet

    stdin.write('[5~'); // PgUp
    await delay(120);

    const scrolled = stripAnsi(lastFrame() ?? '');
    expect(scrolled).not.toBe(pinned);
    expect(scrolled).not.toContain('LINE60'); // the tail scrolled away
    expect(scrolled).toMatch(/↑\d/); // status bar reports the distance

    stdin.write('[6~'); // PgDn back to the bottom
    await delay(120);

    const repinned = stripAnsi(lastFrame() ?? '');
    expect(repinned).toContain('LINE60');
    expect(repinned).not.toMatch(/↑\d/);
    unmount();
  });

  it('renders a placeholder instead of a broken frame when the terminal is too short', async () => {
    const fc = new FakeController();
    const { stdout, lastFrame, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(60);

    Object.defineProperty(stdout, 'rows', { value: 8, configurable: true });
    stdout.emit('resize');
    await delay(120); // resize is throttled 50 ms

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Terminal too small');
    // Still strictly shorter than the 8 rows we now claim to have.
    expect(frame.split('\n').length).toBeLessThan(8);
    unmount();
  });
});

describe('overlay frame (A-2b / A-2c)', () => {
  it('swallows PgUp so the transcript does not jump when the overlay closes', async () => {
    // R-P1-7. `ScrollViewport` is unmounted while an overlay is open, but its
    // scroll-intent effect fires once on REMOUNT -- so an intent registered
    // during the overlay was applied the moment the overlay closed, and the
    // transcript jumped a page for no reason the user could connect to.
    const fc = new FakeController();
    const long = Array.from({ length: 60 }, (_, i) => `LINE${i + 1}`).join('\n');
    fc.onPrompt = async () => {
      fc.emit({ type: 'agent_start' });
      fc.emit({ type: 'turn_start' });
      fc.emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: long } });
      fc.emit({
        type: 'turn_end',
        message: { role: 'assistant', content: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      fc.emit({ type: 'agent_end', messages: [] });
    };

    const { lastFrame, stdin, unmount } = mount(fc, { mode: 'fullscreen', initialPrompt: 'go' });
    await delay(120);
    expect(stripAnsi(lastFrame() ?? '')).toContain('LINE60');

    stdin.write('?'); // opens help on an empty idle input
    await delay(80);
    expect(stripAnsi(lastFrame() ?? '')).toContain('Keybindings');

    stdin.write('[5~'); // PgUp - must not reach the transcript
    await delay(80);
    stdin.write(''); // Esc closes the overlay
    await delay(120);

    const after = stripAnsi(lastFrame() ?? '');
    expect(after).toContain('LINE60'); // still pinned to the newest output
    expect(after).not.toMatch(/↑\d/); // and no off-bottom indicator appeared
    unmount();
  });

  it('scrolls the help overlay itself with PgDn', async () => {
    // 22 rows of content against a 16-row viewport. Before this round the tail
    // was clipped by `overflow: hidden` with no scrollbar, no indicator and no
    // key that could reach it.
    const fc = new FakeController();
    const { lastFrame, stdin, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(80);
    stdin.write('?');
    await delay(80);

    const first = stripAnsi(lastFrame() ?? '');
    expect(first).toContain('Keybindings');
    expect(first).toMatch(/1-\d+\/\d+/); // position indicator

    stdin.write('[6~'); // PgDn
    await delay(80);
    const second = stripAnsi(lastFrame() ?? '');
    expect(second).not.toBe(first);

    stdin.write('[6~'); // a second PgDn reaches the end (24 rows, 12 visible)
    await delay(80);
    const third = stripAnsi(lastFrame() ?? '');
    expect(third).toContain('/exit'); // the tail is reachable at all
    expect(third).not.toContain('Keybindings'); // ...and the window really moved
    unmount();
  });

  it('renders the whole overlay unclipped in inline mode (A-2c)', async () => {
    // Inline has no fixed frame, so `maxRows` is Infinity: render everything and
    // show no position indicator. Rarely opened by hand, easy to break silently.
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, { mode: 'inline', initialPrompt: '/help' });
    await delay(80);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Keybindings');
    expect(frame).toContain('/exit'); // nothing was cut
    expect(frame).not.toMatch(/\d+-\d+\/\d+/); // no position indicator
    unmount();
  });
});

describe('reduced motion (A-10)', () => {
  it('shows no braille spinner while streaming when reducedMotion is set', async () => {
    // `ToolCard` honoured this; the assistant marker did not, so the answer
    // marker kept animating for users who had explicitly asked it not to.
    const fc = new FakeController();
    fc.config = { ...CONFIG, reducedMotion: true };
    fc.onPrompt = () =>
      new Promise<void>(() => {
        fc.emit({ type: 'agent_start' });
        fc.emit({ type: 'turn_start' });
        fc.emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: 'partial' } });
      });
    const { lastFrame, unmount } = mount(fc, { initialPrompt: 'go' });
    await delay(80);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('partial');
    expect(frame).not.toMatch(/[⠀-⣿]/); // no braille dots
    unmount();
  });

  it('does animate when reducedMotion is off (so the check above means something)', async () => {
    const fc = new FakeController();
    fc.onPrompt = () =>
      new Promise<void>(() => {
        fc.emit({ type: 'agent_start' });
        fc.emit({ type: 'turn_start' });
        fc.emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: 'partial' } });
      });
    const { lastFrame, unmount } = mount(fc, { initialPrompt: 'go' });
    await delay(80);
    expect(stripAnsi(lastFrame() ?? '')).toMatch(/[⠀-⣿]/);
    unmount();
  });
});

describe('composer hints (A-14)', () => {
  it('always names the abort key while running, however experienced the user', async () => {
    // R-P1-6: removing the status bar's hint cluster made the composer the only
    // place `esc abort` appears. Fading it out after 8 submissions would leave a
    // long-running task with no visible way to stop it -- retiring an emergency
    // exit as if it were a beginner tip.
    const fc = new FakeController();
    fc.config = { ...CONFIG, submitCount: 999 };
    fc.onPrompt = () =>
      new Promise<void>(() => {
        fc.emit({ type: 'agent_start' });
        fc.emit({ type: 'turn_start' });
      });
    const { lastFrame, unmount } = mount(fc, { mode: 'fullscreen', initialPrompt: 'go' });
    await delay(100);
    expect(stripAnsi(lastFrame() ?? '')).toContain('esc abort');
    unmount();
  });

  it('collapses the idle hint once the user has submitted enough times', async () => {
    const fc = new FakeController();
    fc.config = { ...CONFIG, submitCount: 999 };
    const { lastFrame, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(80);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('? help');
    expect(frame).not.toContain('newline');
    unmount();
  });

  it('shows the full idle hint to a new user', async () => {
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(80);
    expect(stripAnsi(lastFrame() ?? '')).toContain('newline');
    unmount();
  });

  it('hides the hint row entirely when hints are disabled', async () => {
    const fc = new FakeController();
    fc.config = { ...CONFIG, hints: false };
    const { lastFrame, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(80);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).not.toContain('? help');
    expect(frame).not.toContain('newline');
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
