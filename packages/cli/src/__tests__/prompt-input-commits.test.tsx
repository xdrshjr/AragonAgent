/**
 * One printable character costs ONE `PromptInput` render (tui-input-flicker-fix
 * AC-4 / §2 R3).
 *
 * This is a REGRESSION GUARD, not a behaviour test. Ink mounts a LEGACY React
 * root, so a `setState` from `useInput` — which runs on a stdin `'data'`
 * listener, outside React — is not batched: each call flushes its own
 * synchronous render, its own whole-tree Yoga layout, and feeds Ink's 32 ms
 * leading+trailing throttle, which turned five state updates into TWO full-frame
 * repaints per keystroke. Nothing about that is visible in the rendered output,
 * so only a counter can catch it coming back.
 *
 * THE COUNTER IS THE COMPONENT ITSELF. `CountedPromptInput` calls `PromptInput`
 * as a plain function, so the hooks belong to the wrapper and every state update
 * inside re-renders exactly the component being counted. A `React.Profiler` or an
 * outer wrapper would count the PARENT's renders, which a child's own `setState`
 * does not cause — the test would pass while the defect was fully present.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { render as renderInk } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { PromptInput } from '../ui/PromptInput.js';
import { getTheme } from '../ui/theme.js';
import { pickGlyphs } from '../ui/glyphs.js';
import { ENTER_NEWLINE_FRAME, PASTE_CLOSE, PASTE_OPEN, PASTE_MAX_BYTES } from '../input/limits.js';
import { createStdinFilter } from '../input/stdin-filter.js';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import type { TermCapabilities } from '../ui/capabilities.js';

const CAPS: TermCapabilities = { colorLevel: 3, unicode: true };
const THEME = getTheme('cool', CAPS);

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => { cleanup(); vi.useRealTimers(); });

let renderCount = 0;

function CountedPromptInput(props: React.ComponentProps<typeof PromptInput>): React.ReactElement {
  renderCount += 1;
  return PromptInput(props);
}

function mount() {
  renderCount = 0;
  return render(
    <CountedPromptInput
      isActive
      running={false}
      history={['earlier prompt']}
      commands={[{ name: 'help', description: 'Show help' }]}
      cwd={process.cwd()}
      theme={THEME}
      caps={CAPS}
      onSubmit={vi.fn((_text: string) => ({ accepted: true }))}
    />,
  );
}

describe('visual navigation and completion context', () => {
  const props = { isActive: true, running: false, history: ['old'],
    commands: [{ name: 'help', description: 'Help' }], cwd: process.cwd(),
    theme: THEME, caps: CAPS };

  it('moves across soft wraps using actual content columns in one commit', async () => {
    const onSubmit = vi.fn(() => ({ accepted: true }));
    const view = render(<CountedPromptInput {...props} cols={16} onSubmit={onSubmit} />);
    await delay(10);
    view.stdin.write('abcdefghijklm'); await delay(10);
    const before = renderCount;
    view.stdin.write('\x1b[A'); await delay(10);
    expect(renderCount - before).toBe(1);
    view.stdin.write('!'); await delay(10);
    view.stdin.write('\r'); await delay(10);
    expect(onSubmit).toHaveBeenCalledWith('abc!defghijklm');
  });

  it('preserves the target visual column across a short logical line', async () => {
    const onSubmit = vi.fn(() => ({ accepted: true }));
    const view = render(<PromptInput {...props} onSubmit={onSubmit} />);
    await delay(10);
    view.stdin.write(`${PASTE_OPEN}abcdef\nx\nabcdef${PASTE_CLOSE}`); await delay(10);
    view.stdin.write('\x1b[A'); await delay(10);
    view.stdin.write('\x1b[A'); await delay(10);
    view.stdin.write('!'); await delay(10);
    view.stdin.write('\r'); await delay(10);
    expect(onSubmit).toHaveBeenCalledWith('abcdef!\nx\nabcdef');
  });

  it('reports only visible completion kind transitions, including budget loss', async () => {
    const onCompletionContextChange = vi.fn();
    const onSubmit = vi.fn(() => ({ accepted: true }));
    const view = render(<PromptInput {...props} onSubmit={onSubmit}
      onCompletionContextChange={onCompletionContextChange} />);
    await delay(10);
    expect(onCompletionContextChange).toHaveBeenLastCalledWith('none');
    view.stdin.write('/'); await delay(10);
    expect(onCompletionContextChange).toHaveBeenLastCalledWith('slash');
    const calls = onCompletionContextChange.mock.calls.length;
    view.stdin.write('\x1b[B'); await delay(10);
    expect(onCompletionContextChange).toHaveBeenCalledTimes(calls);
    view.rerender(<PromptInput {...props} onSubmit={onSubmit} popupMaxHeight={0}
      onCompletionContextChange={onCompletionContextChange} />);
    await delay(10);
    expect(onCompletionContextChange).toHaveBeenLastCalledWith('none');
  });

  it('does not re-report the same completion for a changed callback identity', async () => {
    const report = vi.fn();
    const onSubmit = vi.fn(() => ({ accepted: true }));
    const view = render(<PromptInput {...props} onSubmit={onSubmit}
      onCompletionContextChange={(value) => report(value)} />);
    await delay(10);
    view.rerender(<PromptInput {...props} onSubmit={onSubmit}
      onCompletionContextChange={(value) => report(value)} />);
    await delay(10);
    expect(report).toHaveBeenCalledExactlyOnceWith('none');
  });

  it('reports file completion and clears it while an overlay owns focus', async () => {
    const onCompletionContextChange = vi.fn();
    const onSubmit = vi.fn(() => ({ accepted: true }));
    const cwd = fileURLToPath(new URL('../input/', import.meta.url));
    const view = render(<PromptInput {...props} cwd={cwd} onSubmit={onSubmit}
      onCompletionContextChange={onCompletionContextChange} />);
    await delay(10);
    view.stdin.write('@keymap'); await delay(350);
    expect(onCompletionContextChange).toHaveBeenLastCalledWith('file');
    view.rerender(<PromptInput {...props} cwd={cwd} isActive={false} onSubmit={onSubmit}
      onCompletionContextChange={onCompletionContextChange} />);
    await delay(10);
    expect(onCompletionContextChange).toHaveBeenLastCalledWith('none');
    view.rerender(<PromptInput {...props} cwd={cwd} onSubmit={onSubmit}
      onCompletionContextChange={onCompletionContextChange} />);
    await delay(10);
    expect(onCompletionContextChange).toHaveBeenLastCalledWith('file');
    view.stdin.write('\x1b'); await delay(10);
    expect(onCompletionContextChange).toHaveBeenLastCalledWith('none');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(['draft', `a${ENTER_NEWLINE_FRAME}b`])('preserves new draft %j at both edges', async (draft) => {
    const onSubmit = vi.fn(() => ({ accepted: true }));
    const view = render(<PromptInput {...props} onSubmit={onSubmit} />);
    await delay(10);
    view.stdin.write(draft); await delay(10);
    for (const key of ['\x1b[A', '\x1b[A', '\x1b[A', '\x1b[B', '\x1b[B', '\x1b[B']) {
      view.stdin.write(key); await delay(5);
    }
    view.stdin.write('\r'); await delay(10);
    expect(onSubmit).toHaveBeenCalledWith(draft.replace(ENTER_NEWLINE_FRAME, '\n'));
  });

  it('navigates a recalled draft visually before continuing history and exits history on edit', async () => {
    const onSubmit = vi.fn(() => ({ accepted: true }));
    const view = render(<PromptInput {...props} history={['old', 'abc\nx']}
      onSubmit={onSubmit} />);
    await delay(10);
    for (const key of ['\x1b[A', '\x1b[A', '!', '\x1b[A', '\r']) {
      view.stdin.write(key); await delay(10);
    }
    expect(onSubmit).toHaveBeenCalledWith('a!bc\nx');
  });

  it('drops the preferred visual column after resize', async () => {
    const onSubmit = vi.fn(() => ({ accepted: true }));
    const view = render(<PromptInput {...props} cols={30} onSubmit={onSubmit} />);
    await delay(10);
    view.stdin.write(`${PASTE_OPEN}abcdef\nx\nabcdef${PASTE_CLOSE}`); await delay(10);
    view.stdin.write('\x1b[A'); await delay(10);
    view.rerender(<PromptInput {...props} cols={31} onSubmit={onSubmit} />);
    await delay(10);
    for (const key of ['\x1b[A', '!', '\r']) {
      view.stdin.write(key); await delay(10);
    }
    expect(onSubmit).toHaveBeenCalledWith('a!bcdef\nx\nabcdef');
  });

  it('retains conservative backward Delete when the filter capability is absent', async () => {
    const onSubmit = vi.fn(() => ({ accepted: true }));
    const view = render(<PromptInput {...props} onSubmit={onSubmit} />);
    await delay(10);
    for (const key of ['abc', '\x1b[D', '\x1b[3~', '\r']) {
      view.stdin.write(key); await delay(10);
    }
    expect(onSubmit).toHaveBeenCalledWith('ac');
  });

  it.each([
    ['\x7f', 'ac'], ['\x08', 'ac'], ['\x1b[3~', 'ab'],
    ['\x1b\x7f', 'c'],
  ])('distinguishes deletion through real Ink for %j', async (key, expected) => {
    const source = Object.assign(new PassThrough(), {
      isTTY: true, setRawMode() { return this; }, ref() { return this; },
      unref() { return this; },
    });
    const filter = createStdinFilter(source as unknown as NodeJS.ReadStream,
      { mouse: false, paste: false });
    const output = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true });
    output.resume();
    const onSubmit = vi.fn(() => ({ accepted: true }));
    const app = renderInk(<PromptInput {...props} deleteDisambiguated onSubmit={onSubmit} />, {
      stdin: filter.stdin, stdout: output as unknown as NodeJS.WriteStream,
      stderr: output as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false,
    });
    try {
      await delay(20);
      for (const input of ['abc', '\x1b[D', key, '\r']) {
        source.write(input); await delay(20);
      }
      expect(onSubmit).toHaveBeenCalledWith(expected);
    } finally {
      app.unmount(); app.cleanup(); filter.dispose(); source.destroy(); output.destroy();
    }
  });
});

describe('PromptInput commit count (AC-4)', () => {
  it('renders exactly once per printable character', async () => {
    const { stdin, lastFrame, unmount } = mount();
    await delay(10);

    // The mount renders and the `onDraftChange` / glob effects may settle first;
    // measure from a quiet baseline so only the keystroke is counted.
    const baseline = renderCount;
    stdin.write('a');
    await delay(10);

    expect(renderCount - baseline).toBe(1);
    expect(lastFrame()).toContain('a');
    unmount();
  });

  it('stays at one render per character across a typed word', async () => {
    const { stdin, unmount } = mount();
    await delay(10);
    const baseline = renderCount;

    for (const ch of 'hello') {
      stdin.write(ch);
      await delay(5);
    }

    // Five characters, five renders. Before F3 this was five state updates per
    // character and the number here would be well into the twenties.
    expect(renderCount - baseline).toBe(5);
    unmount();
  });

  it('renders once for a caret move and once for a backspace', async () => {
    const { stdin, unmount } = mount();
    await delay(10);
    stdin.write('ab');
    await delay(10);
    const baseline = renderCount;

    stdin.write('[D'); // left arrow
    await delay(5);
    expect(renderCount - baseline).toBe(1);

    stdin.write(''); // backspace
    await delay(5);
    expect(renderCount - baseline).toBe(2);
    unmount();
  });
});

  describe('newline intents through the mounted editor (tui-shift-enter-copy-queue 3.5)', () => {
    const props = {
      isActive: true, running: false, history: [],
      commands: [{ name: 'help', description: 'Show help' }], cwd: process.cwd(),
      theme: THEME, caps: { colorLevel: 3, unicode: true } as TermCapabilities,
      onSubmit: vi.fn((_text: string) => ({ accepted: true })),
    };

    it('a Shift+Enter frame inserts a newline and does NOT submit', async () => {
      const onSubmit = vi.fn((_text: string) => ({ accepted: true }));
      const view = render(<PromptInput {...props} onSubmit={onSubmit} />);
      await delay(10);
      view.stdin.write('ab');
      await delay(10);
      view.stdin.write(ENTER_NEWLINE_FRAME);
      await delay(10);
      view.stdin.write('cd');
      await delay(10);
      // Two DRAFT rows on screen: the frame became a real line break, and
      // Enter (submit) was never triggered by it.
      const rows = view.lastFrame()!.split('\n');
      const abRow = rows.findIndex((r) => r.includes('ab'));
      const cdRow = rows.findIndex((r) => r.includes('cd'));
      expect(abRow).toBeGreaterThan(-1);
      expect(cdRow).toBeGreaterThan(abRow);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('a frame merged into one chunk with keystrokes keeps byte order', async () => {
      const view = render(<PromptInput {...props} />);
      await delay(10);
      view.stdin.write(`a${ENTER_NEWLINE_FRAME}b`);
      await delay(10);
      // 'a' and 'b' on separate rows, in that order.
      const rows = view.lastFrame()!.split('\n');
      const aRow = rows.findIndex((r) => r.includes('a'));
      const bRow = rows.findIndex((r) => r.includes('b'));
      expect(aRow).toBeGreaterThan(-1);
      expect(bRow).toBeGreaterThan(aRow);
    });

    it('a paste frame and an enter frame in ONE chunk keep both, in byte order', async () => {
      // THE ROUTING BUG THIS PINS: Ink drains its buffer in one `read()`,
      // so the filter's write for a paste and its write for a Shift+Enter
      // arrive as ONE `input` carrying both frame families. The paste
      // branch's `splitPasteFrames` strips the enter frame's NUL and
      // inserts its letter as ordinary text -- a stray `n` and no
      // newline; only `mergeWithPasteRuns` interleaves both families.
      const onSubmit = vi.fn((_text: string) => ({ accepted: true }));
      const view = render(<PromptInput {...props} onSubmit={onSubmit} />);
      await delay(10);
      view.stdin.write(`p${PASTE_OPEN}ast${PASTE_CLOSE}${ENTER_NEWLINE_FRAME}tail`);
      await delay(10);
      const rows = view.lastFrame()!.split('\n');
      const pasteRow = rows.findIndex((r) => r.includes('past'));
      const tailRow = rows.findIndex((r) => r.includes('tail'));
      expect(pasteRow).toBeGreaterThan(-1);
      expect(tailRow).toBeGreaterThan(pasteRow); // the newline landed between them
      // The frame's letter never leaks as visible text.
      expect(rows.some((r) => r.includes('ntail'))).toBe(false);
      expect(onSubmit).not.toHaveBeenCalled();
    });
    it('a bare LF (Ctrl+J) is a newline too', async () => {
      const onSubmit = vi.fn((_text: string) => ({ accepted: true }));
      const view = render(<PromptInput {...props} onSubmit={onSubmit} />);
      await delay(10);
      view.stdin.write('x');
      await delay(10);
      view.stdin.write('\n');
      await delay(10);
      view.stdin.write('y');
      await delay(10);
      const rows = view.lastFrame()!.split('\n');
      expect(rows.findIndex((r) => r.includes('x'))).toBeGreaterThan(-1);
      expect(rows.findIndex((r) => r.includes('y'))).toBeGreaterThan(
        rows.findIndex((r) => r.includes('x')),
      );
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('ONE frame chunk costs ONE render (the one-dispatch rule)', async () => {
      renderCount = 0;
      const view = render(
        <CountedPromptInput
          isActive
          running={false}
          history={[]}
          commands={[]}
          cwd={process.cwd()}
          theme={THEME}
          caps={CAPS}
          onSubmit={vi.fn((_text: string) => ({ accepted: true }))}
        />,
      );
      await delay(10);
      const baseline = renderCount;
      view.stdin.write(`a${ENTER_NEWLINE_FRAME}b`);
      await delay(10);
      expect(renderCount - baseline).toBe(1);
    });
  });

describe('caret integration and escape ownership', () => {
  const props = {
    isActive: true, running: false, history: [],
    commands: [{ name: 'help', description: 'Show help' }], cwd: process.cwd(),
    theme: THEME, caps: { colorLevel: 0, unicode: true } as TermCapabilities,
    onSubmit: vi.fn((_text: string) => ({ accepted: true })),
  };

  it('blinks the empty placeholder without parent work', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const onDraftChange = vi.fn();
    const onPopupRowsChange = vi.fn();
    const view = render(<CountedPromptInput {...props}
      onDraftChange={onDraftChange} onPopupRowsChange={onPopupRowsChange} />);
    await delay(10);
    expect(view.lastFrame()).toContain('_\u5165\u4efb\u52a1\u6216\u95ee\u9898');
    const renders = renderCount;
    const draftCalls = onDraftChange.mock.calls.length;
    const popupCalls = onPopupRowsChange.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(view.lastFrame()).toContain('\u8f93\u5165\u4efb\u52a1\u6216\u95ee\u9898');
    await vi.advanceTimersByTimeAsync(1500);
    expect(renderCount).toBe(renders);
    expect(onDraftChange).toHaveBeenCalledTimes(draftCalls);
    expect(onPopupRowsChange).toHaveBeenCalledTimes(popupCalls);
  });

  it('routes popup dismissal and unconsumed Escape separately, including meta Escape', async () => {
    const onEscape = vi.fn();
    const onEscapeDismiss = vi.fn();
    const view = render(<PromptInput {...props} onEscape={onEscape} onEscapeDismiss={onEscapeDismiss} />);
    await delay(10);
    view.stdin.write('/');
    await delay(10);
    view.stdin.write('\x1b');
    await delay(10);
    expect(onEscapeDismiss).toHaveBeenCalledTimes(1);
    expect(onEscape).not.toHaveBeenCalled();
    view.stdin.write('\x1b');
    await delay(10);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('resets after edit, movement and backspace without changing submitted text', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const onSubmit = vi.fn((_text: string) => ({ accepted: true }));
    const view = render(<PromptInput {...props} onSubmit={onSubmit} />);
    await delay(10);
    view.stdin.write('ab');
    await delay(10);
    await vi.advanceTimersByTimeAsync(500);
    view.stdin.write('\x1b[D');
    await delay(10);
    expect(view.lastFrame()).toContain('a_');
    await vi.advanceTimersByTimeAsync(500);
    expect(view.lastFrame()).toContain('ab');
    view.stdin.write('\x7f');
    await delay(10);
    expect(view.lastFrame()).toContain('_');
    view.stdin.write('\r');
    await delay(10);
    expect(onSubmit).toHaveBeenCalledWith('b');
  });

  it('does not reset on running-state changes, but resets on width and focus changes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const view = render(<PromptInput {...props} />);
    await delay(10);
    await vi.advanceTimersByTimeAsync(500);
    view.rerender(<PromptInput {...props} running />);
    expect(view.lastFrame()).toContain('\u8f93\u5165\u8865\u5145\u8bf4\u660e');
    expect(view.lastFrame()).not.toContain('Esc');
    Object.defineProperty(view.stdout, 'columns', { value: 50, configurable: true });
    view.rerender(<PromptInput {...props} running />);
    expect(view.lastFrame()).toContain('_\u5165\u8865\u5145\u8bf4\u660e');
    view.rerender(<PromptInput {...props} isActive={false} />);
    expect(view.lastFrame()).toContain('\u8f93\u5165\u4efb\u52a1\u6216\u95ee\u9898');
    expect(vi.getTimerCount()).toBe(0);
    view.rerender(<PromptInput {...props} reducedMotion />);
    expect(view.lastFrame()).toContain('_\u5165\u4efb\u52a1\u6216\u95ee\u9898');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the full-row caret reservation and draft budget through both phases', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const onDraftChange = vi.fn();
    const view = render(<PromptInput {...props} onDraftChange={onDraftChange} />);
    Object.defineProperty(view.stdout, 'columns', { value: 20, configurable: true });
    view.rerender(<PromptInput {...props} onDraftChange={onDraftChange} />);
    await delay(10);
    view.stdin.write('x'.repeat(14));
    await delay(10);
    const bright = view.lastFrame()!.split('\n');
    expect(onDraftChange.mock.lastCall?.[0].rows).toBe(2);
    expect(bright).toHaveLength(4);
    const calls = onDraftChange.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    const dark = view.lastFrame()!.split('\n');
    expect(dark.map((row) => stringWidth(row))).toEqual(bright.map((row) => stringWidth(row)));
    expect(onDraftChange).toHaveBeenCalledTimes(calls);
  });

  it.each([0, 3] as const)('keeps zero-width row budgets and submissions stable at color level %s', async (colorLevel) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const body = 'e\u0301\n\u0301\n\u0301e\nxe\u0301';
    const onSubmit = vi.fn((_text: string) => ({ accepted: true }));
    const onDraftChange = vi.fn();
    const view = render(<PromptInput {...props} caps={{ ...props.caps, colorLevel }}
      onSubmit={onSubmit} onDraftChange={onDraftChange} />);
    await delay(10);
    view.stdin.write(`${PASTE_OPEN}${body}${PASTE_CLOSE}`);
    await delay(10);
    // Visit every UTF-16 location, including combining marks and newlines.
    for (let i = 0; i <= body.length; i += 1) {
      const bright = stripAnsi(view.lastFrame()!).split('\n');
      const reports = onDraftChange.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      const dark = stripAnsi(view.lastFrame()!).split('\n');
      expect(dark.map((row) => stringWidth(row))).toEqual(bright.map((row) => stringWidth(row)));
      expect(onDraftChange).toHaveBeenCalledTimes(reports);
      view.stdin.write('\x1b[D');
      await delay(5);
    }
    view.stdin.write('\r');
    await delay(10);
    expect(onSubmit).toHaveBeenCalledWith(body);
  });
});

/**
 * Pasting through a MOUNTED composer (tui-paste-handling T-25 / T-26 / T-27).
 *
 * The pure modules are covered directly elsewhere; what only a mount can show is
 * that the frame stays one draft row tall while `onSubmit` still receives every
 * byte — the two halves of G4 that a unit test can each satisfy separately while
 * the feature is broken.
 */
describe('paste through the composer (section 5.4)', () => {
  const OPEN = PASTE_OPEN;
  const CLOSE = PASTE_CLOSE;

  function mountWith(onSubmit: (text: string) => { accepted: boolean }) {
    return render(
      <CountedPromptInput
        isActive
        running={false}
        history={[]}
        commands={[]}
        cwd={process.cwd()}
        theme={THEME}
        caps={CAPS}
        onSubmit={onSubmit}
      />,
    );
  }

  it('T-25: a 218-line paste becomes ONE token, one draft row, and submits in full', async () => {
    const body = Array.from({ length: 218 }, (_, i) => `line ${i}`).join('\n');
    const onSubmit = vi.fn((_text: string) => ({ accepted: true }));
    const { stdin, lastFrame, unmount } = mountWith(onSubmit);
    await delay(10);

    stdin.write(`${OPEN}${body}${CLOSE}`);
    await delay(20);

    const frame = lastFrame() ?? '';
    expect(frame).toContain('[Pasted text #');
    expect(frame).toContain('+218 lines]');
    // The 218 lines are NOT drawn: that is the whole point of the collapse.
    expect(frame).not.toContain('line 200');
    expect(frame.split('\n').length).toBeLessThan(6);

    stdin.write('\r');
    await delay(20);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toBe(body);
    unmount();
  });

  it('T-26: a 4-line paste is inserted VERBATIM, with no token at all', async () => {
    const body = 'alpha\nbeta\ngamma\ndelta';
    const onSubmit = vi.fn((_text: string) => ({ accepted: true }));
    const { stdin, lastFrame, unmount } = mountWith(onSubmit);
    await delay(10);

    stdin.write(`${OPEN}${body}${CLOSE}`);
    await delay(20);

    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Pasted text');
    expect(frame).toContain('alpha');
    expect(frame).toContain('delta');

    stdin.write('\r');
    await delay(20);
    expect(onSubmit.mock.calls[0]![0]).toBe(body);
    unmount();
  });

  it('AC-1: a paste carrying newlines sends exactly ONE message, never more', async () => {
    // Defect A, stated as the user experiences it: fifteen chunks that are each
    // exactly "\r" used to send fifteen messages.
    const onSubmit = vi.fn((_text: string) => ({ accepted: true }));
    const { stdin, unmount } = mountWith(onSubmit);
    await delay(10);

    stdin.write(`${OPEN}one\ntwo\nthree${CLOSE}`);
    await delay(20);
    expect(onSubmit).not.toHaveBeenCalled();

    stdin.write('\r');
    await delay(20);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('AC-4: no CR, ESC or NUL reaches the rendered draft (G2)', async () => {
    const { stdin, lastFrame, unmount } = mountWith(vi.fn());
    await delay(10);

    stdin.write(`${OPEN}a\rb${CLOSE}`);
    await delay(20);

    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('\r');
    expect(frame).not.toContain('\u0000');
    unmount();
  });

  it('T-27: Backspace after a token removes it whole, in ONE render', async () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const { stdin, lastFrame, unmount } = mountWith(vi.fn());
    await delay(10);
    stdin.write(`${OPEN}${body}${CLOSE}`);
    await delay(20);
    expect(lastFrame()).toContain('[Pasted text #');

    const baseline = renderCount;
    stdin.write('\x7f'); // Backspace
    await delay(20);

    expect(lastFrame()).not.toContain('Pasted text');
    expect(renderCount - baseline).toBe(1);
    unmount();
  });

  it('I-8: an overflowing draft renders exactly the rows it reports', async () => {
    // REGRESSION. The overflow indicator rides the last rendered row inside the
    // same box the draft wraps in, so its 12 cells have to come out of the wrap
    // width. Measured at the full width, a last row that fills the line was
    // wrapped a SECOND time by Ink and the composer drew SEVEN rows while
    // telling `viewportRows` it drew six -- defect C, in the one situation the
    // height bound exists for.
    //
    // Four 90-column lines is 363 characters: under both inline bounds, so it
    // goes in verbatim and makes a TALL draft rather than a token.
    const reported: number[] = [];
    const body = Array.from({ length: 4 }, (_, i) => `${i}`.padEnd(90, 'x')).join('\n');
    const { stdin, lastFrame, unmount } = render(
      <CountedPromptInput
        isActive
        running={false}
        history={[]}
        commands={[]}
        cwd={process.cwd()}
        theme={THEME}
        caps={CAPS}
        onSubmit={vi.fn((_text: string) => ({ accepted: true }))}
        onDraftChange={(next) => reported.push(next.rows)}
      />,
    );
    await delay(10);
    // Four pastes separated by Alt+Enter: the draft overflows `draftMaxRows`,
    // and its last visible row is 90 columns of text rather than a short one.
    for (let i = 0; i < 4; i += 1) {
      stdin.write(`${OPEN}${body}${CLOSE}`);
      await delay(20);
      if (i < 3) {
        stdin.write(ENTER_NEWLINE_FRAME);
        await delay(20);
      }
    }

    const frame = lastFrame() ?? '';
    // Proves the indicator is actually on screen, so the row-count assertion
    // below is not passing on a draft that simply fits.
    expect(frame).toContain(pickGlyphs(CAPS).arrowUp);
    expect(frame.split(String.fromCharCode(10)).length).toBe(reported[reported.length - 1]! + 2); // top and bottom border
    unmount();
  });

  it('keeps ONE render per framed chunk, however large (I-6)', async () => {
    const body = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const { stdin, unmount } = mountWith(vi.fn());
    await delay(10);
    const baseline = renderCount;

    stdin.write(`${OPEN}${body}${CLOSE}`);
    await delay(20);

    expect(renderCount - baseline).toBe(1);
    unmount();
  });
});

describe('editing returns to the unified document tail', () => {
  it('excludes viewport keys before popup navigation and accepts one paste interaction', async () => {
    const interaction = vi.fn();
    const submit = vi.fn((_text: string) => ({ accepted: true }));
    const view = render(<PromptInput isActive cursorVisible={false} cols={39}
      running={false} history={[]} commands={[{ name: 'help', description: 'Help' }]}
      cwd={process.cwd()} theme={THEME} caps={CAPS} onSubmit={submit}
      onInteraction={interaction} />);
    await delay(20);
    view.stdin.write('/'); await delay(20);
    expect(interaction).toHaveBeenCalledTimes(1);
    for (const key of ['\x1b[1;2A', '\x1b[1;2B', '\x1b[5~', '\x1b[6~']) {
      view.stdin.write(key); await delay(10);
    }
    expect(interaction).toHaveBeenCalledTimes(1);
    view.stdin.write('\x15'); await delay(10);
    interaction.mockClear();
    view.stdin.write(`${PASTE_OPEN}hello world${PASTE_CLOSE}`); await delay(20);
    expect(interaction).toHaveBeenCalledTimes(1);
    view.stdin.write('\r'); await delay(20);
    expect(submit).toHaveBeenCalledExactlyOnceWith('hello world');
    view.unmount();
  });
});


describe('合并输入的同步接管事务', () => {
  it.each(['burst', 'bracketed'])('真实过滤器拒绝 %s 超限块且不提交旧稿', async (kind) => {
    const source = Object.assign(new PassThrough(), {
      isTTY: true, setRawMode() { return this; }, ref() { return this; },
      unref() { return this; },
    });
    const onSubmit = vi.fn((_text: string) => ({ accepted: true }));
    const warn = vi.fn();
    const filter = createStdinFilter(source as unknown as NodeJS.ReadStream,
      { mouse: false, paste: true }, undefined, warn);
    const output = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true });
    output.resume();
    const app = renderInk(<PromptInput isActive running={false} history={[]} commands={[]}
      cwd={process.cwd()} theme={THEME} caps={CAPS} onSubmit={onSubmit} />, {
      stdin: filter.stdin, stdout: output as unknown as NodeJS.WriteStream,
      stderr: output as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false,
    });
    try {
      await delay(20);
      source.write('old');
      await delay(20);
      const body = 'x'.repeat(PASTE_MAX_BYTES + 1);
      const paste = kind === 'bracketed' ? `\x1b[200~${body}\x1b[201~` : body;
      source.write(`${paste}\x1b[13utail`);
      await delay(20);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      source.write('next');
      await delay(20);
      source.write('\r');
      await delay(20);
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith('oldnext');
    } finally {
      app.unmount();
      app.cleanup();
      filter.dispose();
      source.destroy();
      output.destroy();
    }
  });

  function mountTransaction(onSubmit = vi.fn((_text: string) => ({ accepted: true }))) {
    renderCount = 0;
    const onNotice = vi.fn();
    const view = render(<CountedPromptInput isActive running={false} history={[]}
      commands={[{ name: 'help', description: 'Help' }]} cwd={process.cwd()}
      theme={THEME} caps={CAPS} onSubmit={onSubmit} onNotice={onNotice} />);
    return { ...view, onSubmit, onNotice };
  }

  it('提交当前局部正文一次，其余输入留稿，仅更新一次编辑器', async () => {
    const view = mountTransaction();
    await delay(10);
    const baseline = renderCount;
    view.stdin.write(`a${ENTER_NEWLINE_FRAME}b\rc\rd`);
    await delay(10);
    expect(view.onSubmit).toHaveBeenCalledExactlyOnceWith('a\nb');
    expect(view.lastFrame()).toContain('cd');
    expect(renderCount - baseline).toBe(1);
    expect(view.onNotice).toHaveBeenCalledExactlyOnceWith('warn',
      'More input is kept in the draft; press Enter to send.');
  });

  it.each(['reject', 'throw'])('%s 保留原稿与本块新增输入', async (mode) => {
    const onSubmit = vi.fn(() => {
      if (mode === 'throw') throw new Error('Unavailable');
      return { accepted: false, reason: 'Unavailable' };
    });
    const view = mountTransaction(onSubmit);
    await delay(10);
    view.stdin.write('old');
    await delay(10);
    view.stdin.write(`a${ENTER_NEWLINE_FRAME}b\rc`);
    await delay(10);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('olda\nb');
    expect(view.lastFrame()).toContain('olda');
    expect(view.lastFrame()).toContain('bc');
    expect(view.onNotice).toHaveBeenCalledWith('error', 'Unavailable');
  });

  it('paste 后合并 CR 提交展开后的全文', async () => {
    const view = mountTransaction();
    await delay(10);
    view.stdin.write(`${PASTE_OPEN}a\nb${PASTE_CLOSE}\r`);
    await delay(10);
    expect(view.onSubmit).toHaveBeenCalledExactlyOnceWith('a\nb');
  });

  it('混合 bare slash 使用局部候选，Shift+Enter 不执行候选', async () => {
    const view = mountTransaction();
    await delay(10);
    view.stdin.write('/he\r');
    await delay(10);
    expect(view.onSubmit).toHaveBeenCalledExactlyOnceWith('/help');
    view.onSubmit.mockClear();
    view.stdin.write(`/he${ENTER_NEWLINE_FRAME}tail`);
    await delay(10);
    expect(view.onSubmit).not.toHaveBeenCalled();
    view.stdin.write('\r');
    await delay(10);
    expect(view.onSubmit).toHaveBeenCalledExactlyOnceWith('/he\ntail');
  });

  it.each([0, 1, 2])('光标位置 %i 的修饰 Enter 恰好插入一个 LF', async (cursor) => {
    const view = mountTransaction();
    await delay(10);
    view.stdin.write('ab');
    await delay(10);
    for (let index = 2; index > cursor; index -= 1) {
      view.stdin.write('\x1b[D');
      await delay(5);
    }
    view.stdin.write(ENTER_NEWLINE_FRAME);
    await delay(10);
    view.stdin.write('\r');
    await delay(10);
    expect(view.onSubmit).toHaveBeenCalledExactlyOnceWith(
      'ab'.slice(0, cursor) + '\n' + 'ab'.slice(cursor),
    );
  });

  it('补全打开时全局翻页和 Shift+Tab 不修改草稿', async () => {
    const view = mountTransaction();
    await delay(10);
    view.stdin.write('/he');
    await delay(10);
    const baseline = renderCount;
    for (const key of ['\x1b[Z', '\x1b[5~', '\x1b[6~']) {
      view.stdin.write(key);
      await delay(5);
    }
    expect(renderCount).toBe(baseline);
    expect(view.onSubmit).not.toHaveBeenCalled();
    view.stdin.write('\r');
    await delay(10);
    expect(view.onSubmit).toHaveBeenCalledExactlyOnceWith('/help');
  });

  it('保稿候选粘贴超限时整块拒绝，不调用提交也不更新编辑器', async () => {
    const view = mountTransaction();
    await delay(10);
    view.stdin.write('old');
    await delay(10);
    const baseline = renderCount;
    const paste = `${PASTE_OPEN}${'x'.repeat(401)}${PASTE_CLOSE}`;
    view.stdin.write(`${paste.repeat(32)}\r${paste}`);
    await delay(10);
    expect(view.onSubmit).not.toHaveBeenCalled();
    expect(renderCount).toBe(baseline);
    expect(view.onNotice).toHaveBeenCalledWith('warn', expect.stringContaining('Too many'));
    view.stdin.write('\r');
    await delay(10);
    expect(view.onSubmit).toHaveBeenCalledExactlyOnceWith('old');
  });
});
