import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { Text } from 'ink';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { PromptCaret } from '../ui/PromptCaret.js';

const key = {};
const caret = (props: Partial<React.ComponentProps<typeof PromptCaret>> = {}) => (
  <Text><PromptCaret text="a" active reducedMotion={false} colorLevel={0} resetKey={key} {...props} /></Text>
);

beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('PromptCaret phase and lifecycle', () => {
  it('starts bright and alternates exactly at 500ms', async () => {
    const view = render(caret());
    expect(view.lastFrame()).toBe('_');
    await vi.advanceTimersByTimeAsync(499);
    expect(view.lastFrame()).toBe('_');
    await vi.advanceTimersByTimeAsync(1);
    expect(view.lastFrame()).toBe('a');
    await vi.advanceTimersByTimeAsync(500);
    expect(view.lastFrame()).toBe('_');
  });

  it('resets on editing but keeps phase on unrelated rerenders', async () => {
    const view = render(caret());
    await vi.advanceTimersByTimeAsync(500);
    view.rerender(caret({ color: 'blue' }));
    expect(stripAnsi(view.lastFrame()!)).toBe('a');
    view.rerender(caret({ resetKey: {} }));
    await vi.advanceTimersByTimeAsync(499);
    expect(stripAnsi(view.lastFrame()!)).toBe('_');
    await vi.advanceTimersByTimeAsync(1);
    expect(stripAnsi(view.lastFrame()!)).toBe('a');
  });

  it('cleans timers on blur, reduced motion and unmount, then relights on focus', async () => {
    const view = render(caret());
    await vi.advanceTimersByTimeAsync(500);
    view.rerender(caret({ active: false }));
    expect(view.lastFrame()).toBe('a');
    expect(vi.getTimerCount()).toBe(0);
    view.rerender(caret());
    expect(view.lastFrame()).toBe('_');
    expect(vi.getTimerCount()).toBe(1);
    view.rerender(caret({ reducedMotion: true }));
    expect(view.lastFrame()).toBe('_');
    expect(vi.getTimerCount()).toBe(0);
    view.rerender(caret());
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['a', '_', ' ', '\u4e2d', 'e\u0301', '\u0301e', '_\u0301'])('keeps equal columns and visible contrast for %j', async (text) => {
    const view = render(<Text><PromptCaret text={text} active reducedMotion={false} colorLevel={0} resetKey={key} />|</Text>);
    const bright = view.lastFrame()!.slice(0, -1);
    expect(bright).not.toBe(text);
    expect(stringWidth(bright)).toBe(stringWidth(text));
    await vi.advanceTimersByTimeAsync(500);
    expect(view.lastFrame()).toBe(text + '|');
  });

  it('uses inverse without replacing colored text', async () => {
    const oldLevel = chalk.level;
    chalk.level = 3;
    try {
      const view = render(caret({ text: '\u4e2d', colorLevel: 3 }));
      const bright = view.lastFrame()!;
      expect(bright).toContain('\x1b[7m');
      await vi.advanceTimersByTimeAsync(500);
      expect(view.lastFrame()).not.toContain('\x1b[7m');
      expect(stripAnsi(bright)).toBe(stripAnsi(view.lastFrame()!));
    } finally { chalk.level = oldLevel; }
  });
});
