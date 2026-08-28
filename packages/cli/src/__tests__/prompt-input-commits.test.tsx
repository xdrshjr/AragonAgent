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

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { PromptInput } from '../ui/PromptInput.js';
import { getTheme } from '../ui/theme.js';
import { pickGlyphs } from '../ui/glyphs.js';
import { PASTE_CLOSE, PASTE_OPEN } from '../input/limits.js';
import type { TermCapabilities } from '../ui/capabilities.js';

const CAPS: TermCapabilities = { colorLevel: 3, unicode: true };
const THEME = getTheme('cool', CAPS);

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
      onSubmit={vi.fn()}
    />,
  );
}

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

  function mountWith(onSubmit: (text: string) => void) {
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
    const onSubmit = vi.fn();
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
    const onSubmit = vi.fn();
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
    const onSubmit = vi.fn();
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
        onSubmit={vi.fn()}
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
        stdin.write(String.fromCharCode(27, 13));
        await delay(20);
      }
    }

    const frame = lastFrame() ?? '';
    // Proves the indicator is actually on screen, so the row-count assertion
    // below is not passing on a draft that simply fits.
    expect(frame).toContain(pickGlyphs(CAPS).arrowUp);
    expect(frame.split(String.fromCharCode(10)).length).toBe(reported[reported.length - 1]);
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
