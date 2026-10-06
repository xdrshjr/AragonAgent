import React from 'react';
import { describe, expect, it } from 'vitest';
import { Box, Text, useInput, type DOMElement } from 'ink';
import stringWidth from 'string-width';
import { ScrollViewport } from '../ui/layout/ScrollViewport.js';
import { AppShell } from '../ui/layout/AppShell.js';
import { getTheme } from '../ui/theme.js';
import { PromptInput } from '../ui/PromptInput.js';
import { createScrollbarBridge } from '../ui/scrollbar-controller.js';
import { createFrameObserver } from '../ui/frame-observer.js';
import { wrapStdoutForFrames } from '../ui/stdout-frame-writer.js';
import { createFrameDiffer } from '../ui/frame-differ.js';
import { PASTE_OPEN, PASTE_CLOSE } from '../input/limits.js';
import { createTerminalHarness, settleTerminal } from './helpers/terminal-harness.js';
import { TranscriptList } from '../ui/Transcript.js';
import { useHeightStore } from '../ui/use-height-store.js';
import { ViewportGeometryContext } from '../ui/layout/viewport-geometry.js';
import { Composer } from '../ui/Composer.js';
import { ActivityLine } from '../ui/ActivityLine.js';

const caps = { unicode: false, colorLevel: 0 } as const;
const theme = getTheme('cool', caps);

describe('unified document in real Ink layout', () => {
  it('滚到顶部时大量 Markdown 高度修正仍能收敛并保持滚动可用', async () => {
    const terminal = createTerminalHarness(80, 200);
    const entries = Array.from({ length: 400 }, (_, i) => ({
      id: String(i), kind: 'assistant' as const,
      text: '\n'.repeat(220) + `结果 ${i}`, streaming: false, thinkingOpen: false,
    }));
    let renders = 0;
    function Body() {
      const heights = useHeightStore();
      renders++;
      return <TranscriptList entries={entries} heights={heights} expandedToolIds={{}}
        thinkingVisible reducedMotion density="compact" theme={theme}
        caps={caps} windowSize={20000} cols={79} />;
    }
    const frame = (nonce: number, kind: 'toTop' | 'toBottom' = 'toTop') =>
      <Box height={196} width={80}>
        <ScrollViewport theme={theme} caps={caps} intent={{ kind, nonce }}>
          <Body />
        </ScrollViewport>
      </Box>;
    try {
      terminal.mount(frame(0));
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('结果 399');
      terminal.rerender(frame(1));
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('结果 0');
      expect(terminal.lastFrame()).not.toMatch(/Maximum update depth|Minified React error/);
      const settled = renders;
      await settleTerminal();
      expect(renders).toBe(settled);
      terminal.rerender(frame(2, 'toBottom'));
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('结果 399');
    } finally { terminal.dispose(); }
  }, 120000);

  it('大视口中的 Markdown 高度估算逐步修正后仍能收敛并继续 resize', async () => {
    const terminal = createTerminalHarness(80, 200);
    const measured: number[] = [];
    const entries = Array.from({ length: 160 }, (_, i) => ({
      id: String(i), kind: 'assistant' as const,
      text: '\n'.repeat(220) + `结果 ${i}`, streaming: false, thinkingOpen: false,
    }));
    function Body() {
      const heights = useHeightStore();
      measured.push(React.useContext(ViewportGeometryContext).contentRows);
      return <TranscriptList entries={entries} heights={heights} expandedToolIds={{}}
        thinkingVisible reducedMotion density="compact" theme={theme}
        caps={caps} windowSize={20000} cols={79} />;
    }
    const frame = (rows: number) => <Box height={rows - 4} width={80}>
      <ScrollViewport theme={theme} caps={caps}><Body /></ScrollViewport>
    </Box>;
    try {
      terminal.mount(frame(200));
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('结果 159');
      expect(terminal.lastFrame()).not.toMatch(/Maximum update depth|Minified React error/);
      expect(measured.at(-1)).toBe(160);
      const settled = measured.length;
      await settleTerminal();
      expect(measured.length).toBe(settled);
      terminal.resize(80, 24); terminal.rerender(frame(24));
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('结果 159');
    } finally { terminal.dispose(); }
  }, 60000);

  it('keeps Chinese draft, paste payload and caret through hidden and small layouts', async () => {
    const terminal = createTerminalHarness();
    const submissions: string[] = [];
    let interactions = 0;
    function EditorFrame({ active, nonce }: { active: boolean; nonce: number }) {
      useInput(() => {}); // App's global handler also drains input while the editor is inactive.
      const [pin, setPin] = React.useState(0);
      return <Box height={20} width={80}>
        <ScrollViewport active={active} theme={theme} caps={caps}
          pinToBottomNonce={pin} intent={{ kind: 'lineUp', nonce, repeat: 15 }}
          footer={<PromptInput isActive={active} cols={79} history={[]} commands={[]}
            running={false} cwd={process.cwd()} theme={theme} caps={caps}
            onInteraction={() => { interactions++; setPin((n) => n + 1); }}
            onSubmit={(text) => submissions.push(text)} />}>
          <Text>{'history\n'.repeat(100)}</Text>
        </ScrollViewport>
      </Box>;
    }
    try {
      terminal.mount(<EditorFrame active nonce={0} />); await settleTerminal();
      terminal.input('中文🙂'); await settleTerminal();
      terminal.input('\x1b[D'); await settleTerminal();
      terminal.input(`${PASTE_OPEN}pasted\ntext${PASTE_CLOSE}`); await settleTerminal();
      terminal.rerender(<EditorFrame active nonce={1} />); await settleTerminal();
      expect(terminal.lastFrame()).not.toContain('中文');
      terminal.rerender(<EditorFrame active={false} nonce={2} />); await settleTerminal();
      terminal.resize(39, 11);
      terminal.input('ignored'); await settleTerminal();
      terminal.resize(80, 24);
      terminal.rerender(<EditorFrame active nonce={2} />); await settleTerminal();
      const before = interactions;
      terminal.input('X'); await settleTerminal();
      expect(interactions).toBe(before + 1);
      expect(terminal.lastFrame()).toContain('中文');
      terminal.input('\r'); await settleTerminal();
      expect(submissions).toHaveLength(1);
      expect(submissions[0]).toContain('pasted\ntext');
      expect(submissions[0]).toContain('X');
      expect(submissions[0]).not.toContain('ignored');
      expect(submissions[0]).toBe('中文pasted\ntextX🙂');
    } finally { terminal.dispose(); }
  });

  it.each([false, true])('enables real non-debug Ink drag with differ=%s', async (diff) => {
    const terminal = createTerminalHarness(80, 24, false);
    const bridge = createScrollbarBridge(() => true);
    const writer = diff ? wrapStdoutForFrames(terminal.stdout,
      createFrameDiffer({ sync: false, rows: () => 24 })) : null;
    const observer = createFrameObserver({ stdout: writer?.stdout ?? terminal.stdout,
      terminal: terminal.stdout, scrollbar: bridge });
    // The harness can expose the same real output through the observation boundary.
    const { render } = await import('ink');
    const offsets: number[] = [];
    const node = (redraw: number) => <AppShell rows={24} cols={80}
      header={<Text>Header</Text>} toast={<Text>Activity</Text>}
      status={<Text>Status {redraw}</Text>}
      viewport={<ScrollViewport showScrollIndicator scrollbar={bridge}
        cols={79} theme={theme} caps={caps} onScrolledLinesChange={(n) => offsets.push(n)}
        footer={<Text>EDITOR</Text>}><Text>{'history\n'.repeat(100)}</Text></ScrollViewport>} />;
    const instance = render(node(0),
    { stdout: observer.stdout, stdin: terminal.stdin, stderr: terminal.stdout,
      patchConsole: false, exitOnCtrlC: false });
    try {
      await settleTerminal();
      expect(bridge.frameReady).toBe(true);
      let redraws = 0;
      bridge.requestRedraw = () => instance.rerender(node(++redraws));
      terminal.resize(81, 24);
      terminal.resize(80, 24);
      expect(bridge.frameReady).toBe(false);
      await settleTerminal(); await settleTerminal();
      expect(redraws).toBe(1);
      expect(bridge.frameReady).toBe(true);
      const g = bridge.geometry!;
      const pointer = { x: 80, button: 0 as const, shift: false, alt: false, ctrl: false };
      bridge.controller!.handle({ ...pointer, kind: 'press', y: g.trackTop + g.thumb!.start });
      bridge.controller!.handle({ ...pointer, kind: 'release', y: 2 });
      await settleTerminal();
      expect(offsets.at(-1)).toBe(g.contentRows - g.trackRows);
      terminal.resize(90, 30);
      expect(bridge.frameReady).toBe(false);
      expect(bridge.controller!.handle({ ...pointer, kind: 'press', y: 2 })).toBe(false);
    } finally {
      instance.unmount(); instance.cleanup(); observer.dispose(); writer?.dispose();
      terminal.dispose();
    }
  });
  it.each([[40, 12], [49, 20], [80, 24], [120, 40]])(
    'draws the last-column track at %i x %i', async (cols, rows) => {
      const terminal = createTerminalHarness(cols, rows);
      const node = (nonce: number) => <AppShell rows={rows} cols={cols}
        header={<Text>Header</Text>} toast={<Text>Activity</Text>} status={<Text>Status</Text>}
        viewport={<ScrollViewport cols={cols - 1} theme={theme} caps={caps}
          showScrollIndicator intent={{ kind: 'lineUp', nonce, repeat: 4 }}
          footer={<Text>{'EDITOR1\nEDITOR2\nEDITOR3\nEDITOR4'}</Text>}>
          <Text>{Array.from({ length: 100 }, (_, i) => `message ${i}`).join('\n')}</Text>
        </ScrollViewport>} />;
      try {
        terminal.mount(node(0));
        await settleTerminal();
        const lines = terminal.lastFrame().trimEnd().split('\n');
        expect(lines).toHaveLength(rows - 1);
        expect(lines.slice(1, rows - 3).every((line) =>
          stringWidth(line) === cols && /[|#]$/.test(line))).toBe(true);
        expect(terminal.lastFrame()).toContain('EDITOR4');
        terminal.rerender(node(1));
        await settleTerminal();
        expect(terminal.lastFrame()).not.toContain('EDITOR');
        expect(terminal.lastFrame()).toContain('message 99');
      } finally { terminal.dispose(); }
    });
  it('preserves the footer instance across overlay and restores its scroll position', async () => {
    const terminal = createTerminalHarness();
    let mounts = 0;
    function Footer() {
      React.useEffect(() => { mounts++; }, []);
      return <Text>draft-preserved</Text>;
    }
    const node = (active: boolean, nonce: number) => <Box height={20} width={80}>
      <ScrollViewport active={active} overlay={active ? null : <Text>overlay</Text>}
        theme={theme} caps={caps} footer={<Footer />}
        intent={{ kind: 'lineUp', nonce, repeat: 10 }}>
        <Text>{Array.from({ length: 100 }, (_, i) => `message ${i}`).join('\n')}</Text>
      </ScrollViewport></Box>;
    try {
      terminal.mount(node(true, 0)); await settleTerminal();
      terminal.rerender(node(true, 1)); await settleTerminal();
      const before = terminal.lastFrame();
      terminal.rerender(node(false, 2)); await settleTerminal();
      expect(terminal.lastFrame()).toContain('overlay');
      terminal.rerender(node(true, 2)); await settleTerminal();
      expect(terminal.lastFrame()).toBe(before);
      expect(mounts).toBe(1);
    } finally { terminal.dispose(); }
  });
});

describe('run status row in the scrolling footer (real Ink)', () => {
  const rich = { unicode: true, colorLevel: 0 } as const;
  const richTheme = getTheme('cool', rich);
  const braille = (frame: string): number => (frame.match(/[\u2800-\u28ff]/g) ?? []).length;
  const interrupt = 'esc\u00d72 interrupt';

  /**
   * The wiring `App` performs, in miniature: a Composer carrying the run row in
   * the scroll footer, a fixed bottom row that shows the activity line ONLY while
   * the run row is out of the viewport, one shared visibility boolean.
   */
  function Frame({ nonce, kind = 'lineUp', repeat = 0 }: {
    nonce: number; kind?: 'lineUp' | 'toBottom'; repeat?: number;
  }) {
    const activityRef = React.useRef<DOMElement>(null);
    const [rowVisible, setRowVisible] = React.useState(true);
    useInput(() => {});
    const activity = { startedAt: 1_700_000_000_000, elapsedMs: 1_000, reducedMotion: false };
    return <Box height={22} width={80} flexDirection="column">
      <ScrollViewport theme={richTheme} caps={rich} cols={79}
        activityRef={activityRef} onActivityVisibilityChange={setRowVisible}
        intent={nonce === 0 ? undefined : { kind, nonce, repeat }}
        footer={<Composer cols={79} isActive running history={[]} commands={[]}
          cwd={process.cwd()} showHint submitCount={0} hintsEnabled agentMode="build"
          theme={richTheme} caps={rich} onSubmit={() => {}}
          runRow={{ activity, live: rowVisible, rowRef: activityRef }} />}>
        <Text>{Array.from({ length: 100 }, (_, i) => `message ${i}`).join('\n')}</Text>
      </ScrollViewport>
      <Box height={1} flexShrink={0}>
        {rowVisible ? null : <ActivityLine {...activity} theme={richTheme} caps={rich} />}
      </Box>
    </Box>;
  }

  const rowsOf = (frame: string): string[] => frame.split('\n');

  it('T10: sits directly above the input box with exactly one animation', async () => {
    const terminal = createTerminalHarness(80, 24);
    try {
      terminal.mount(<Frame nonce={0} />);
      await settleTerminal();
      const rows = rowsOf(terminal.lastFrame());
      const top = rows.findIndex((row) => row.includes('\u256d'));
      expect(top).toBeGreaterThan(0);
      expect(rows[top - 1]).toContain(interrupt);
      expect(braille(terminal.lastFrame())).toBe(1);
      expect(rows[top - 1]).toMatch(/[\u2800-\u28ff]/);
    } finally { terminal.dispose(); }
  });

  it('T11/T12: scrolls out with the input, hands the animation to the bottom row, and back', async () => {
    const terminal = createTerminalHarness(80, 24);
    try {
      terminal.mount(<Frame nonce={0} />);
      await settleTerminal();
      let sawOut = false;
      let sawBoth = false;
      for (let step = 1; step <= 8; step += 1) {
        terminal.rerender(<Frame nonce={step} repeat={1} />);
        await settleTerminal();
        const frame = terminal.lastFrame();
        // Steady-state frames hold exactly one animation, whichever row owns it.
        expect(braille(frame), `step ${step}`).toBe(1);
        const inView = frame.includes(interrupt);
        const rows = rowsOf(frame);
        if (inView) {
          // A one-row element is never cut in half: whenever any of it shows,
          // every clause shows (the input box below it may already be clipped).
          expect(frame).toContain('\u23ce steer');
          expect(frame).toContain('ctrl+c\u00d72 exit');
          sawBoth = true;
        } else {
          sawOut = true;
          expect(rows.filter((row) => row.trim() !== '').at(-1)).toMatch(/[\u2800-\u28ff]/);
        }
      }
      expect(sawBoth).toBe(true);
      expect(sawOut).toBe(true);

      terminal.rerender(<Frame nonce={20} kind="toBottom" />);
      await settleTerminal();
      const back = terminal.lastFrame();
      expect(back).toContain(interrupt);
      expect(braille(back)).toBe(1);
      const rows = rowsOf(back);
      expect(rows.at(-1)!.trim()).not.toMatch(/[\u2800-\u28ff]/);
    } finally { terminal.dispose(); }
  });
});
