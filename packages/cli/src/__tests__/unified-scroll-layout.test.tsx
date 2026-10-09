import React from 'react';
import { describe, expect, it } from 'vitest';
import { Box, Text, useInput } from 'ink';
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
import { StatusBar } from '../ui/StatusBar.js';
import { BottomStatusRow } from '../ui/BottomStatusRow.js';
import { initialViewState } from '../agent/reducer.js';
import { interactionCopy } from '../ui/interaction-copy.js';

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
      <AppShell rows={200} cols={80} header={<Text>Header</Text>}
        statusRows={1} composerSlotRows={3} viewportRows={194}
        composer={<Text>fixed-editor</Text>} status={<Text>Status</Text>}
        viewport={<ScrollViewport theme={theme} caps={caps} intent={{ kind, nonce }}>
          <Body />
        </ScrollViewport>} />;
    try {
      terminal.mount(frame(0));
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('结果 399');
      for (const frame of terminal.layoutFrames) {
        expect(frame.trimEnd().split('\n')).toHaveLength(199);
        expect(frame.split('\n')[197]).toContain('fixed-editor');
      }
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
      for (const frame of terminal.layoutFrames) {
        expect(frame.trimEnd().split('\n')).toHaveLength(199);
        expect(frame.split('\n')[197]).toContain('fixed-editor');
      }
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
    const frame = (rows: number) => <AppShell rows={rows} cols={80}
      header={<Text>Header</Text>} statusRows={1} composerSlotRows={3}
      viewportRows={rows - 6} composer={<Text>fixed-editor</Text>}
      status={<Text>Status</Text>}
      viewport={<ScrollViewport theme={theme} caps={caps}><Body /></ScrollViewport>} />;
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
      return <AppShell rows={24} cols={80} header={<Text>Header</Text>}
        statusRows={1} composerSlotRows={3} viewportRows={18}
        status={<Text>Status</Text>}
        composer={<PromptInput isActive={active} cols={79} history={[]} commands={[]}
            running={false} cwd={process.cwd()} theme={theme} caps={caps}
            onInteraction={() => { interactions++; setPin((n) => n + 1); }}
            onSubmit={(text) => { submissions.push(text); return { accepted: true }; }} />}
        viewport={<ScrollViewport active={active} theme={theme} caps={caps}
          pinToBottomNonce={pin} intent={{ kind: 'lineUp', nonce, repeat: 15 }}>
          <Text>{'history\n'.repeat(100)}</Text>
        </ScrollViewport>} />;
    }
    try {
      terminal.mount(<EditorFrame active nonce={0} />); await settleTerminal();
      terminal.input('中文🙂'); await settleTerminal();
      terminal.input('\x1b[D'); await settleTerminal();
      terminal.input(`${PASTE_OPEN}pasted\ntext${PASTE_CLOSE}`); await settleTerminal();
      terminal.rerender(<EditorFrame active nonce={1} />); await settleTerminal();
      expect(terminal.lastFrame()).toContain('中文');
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
      header={<Text>Header</Text>} statusRows={1} composerSlotRows={3} viewportRows={18}
      composer={<Text>EDITOR</Text>}
      status={<Text>Status {redraw}</Text>}
      viewport={<ScrollViewport showScrollIndicator scrollbar={bridge}
        cols={79} theme={theme} caps={caps} onScrolledLinesChange={(n) => offsets.push(n)}
        ><Text>{'history\n'.repeat(100)}</Text></ScrollViewport>} />;
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
        header={<Text>Header</Text>} statusRows={1} composerSlotRows={4} viewportRows={rows - 7}
        composer={<Text>{"EDITOR1\nEDITOR2\nEDITOR3\nEDITOR4"}</Text>} status={<Text>Status</Text>}
        viewport={<ScrollViewport cols={cols - 1} theme={theme} caps={caps}
          showScrollIndicator intent={{ kind: 'lineUp', nonce, repeat: 4 }}
          >
          <Text>{Array.from({ length: 100 }, (_, i) => `message ${i}`).join('\n')}</Text>
        </ScrollViewport>} />;
      try {
        terminal.mount(node(0));
        await settleTerminal();
        const lines = terminal.lastFrame().trimEnd().split('\n');
        expect(lines).toHaveLength(rows - 1);
        expect(lines.slice(1, rows - 6).every((line) =>
          stringWidth(line) === cols && /[|#]$/.test(line))).toBe(true);
        expect(terminal.lastFrame()).toContain('EDITOR4');
        terminal.rerender(node(1));
        await settleTerminal();
        expect(terminal.lastFrame()).toContain('EDITOR4');
        expect(terminal.lastFrame()).toContain('message 95');
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

describe('fixed run status and editor (real Ink)', () => {
  const rich = { unicode: true, colorLevel: 0 } as const;
  const richTheme = getTheme('cool', rich);
  const state = initialViewState();
  const braille = (frame: string): number => (frame.match(/[\u2800-\u28ff]/g) ?? []).length;

  function Frame({ nonce, kind = 'lineUp', repeat = 0 }: {
    nonce: number; kind?: 'lineUp' | 'toBottom'; repeat?: number;
  }) {
    useInput(() => {});
    return <AppShell rows={24} cols={80} header={<Text>Header</Text>}
      statusRows={2} viewportRows={17} composerSlotRows={3} composer={<Composer cols={79} cursorVisible={false} isActive running history={[]} commands={[]}
          cwd={process.cwd()} showHint submitCount={0} hintsEnabled agentMode="build"
          theme={richTheme} caps={rich} onSubmit={() => ({ accepted: true })} />}
      viewport={<ScrollViewport theme={richTheme} caps={rich} cols={79}
        intent={nonce === 0 ? undefined : { kind, nonce, repeat }}
        >
        <Text>{Array.from({ length: 100 }, (_, i) => `message ${i}`).join('\n')}</Text>
      </ScrollViewport>}
      details={<Text>{interactionCopy.interrupt}</Text>}
      status={<StatusBar columns={80} speedKnown status="running" runPhase="generating" model="test" provider="test"
        usageTotal={state.usageTotal} context={state.context} elapsedMs={1000}
        thinkingLevel="xhigh" tokPerSec={10} theme={richTheme} caps={rich} />} />;
  }

  it('keeps actions and the sole activity animation on the final two rows', async () => {
    const terminal = createTerminalHarness(80, 24);
    try {
      terminal.mount(<Frame nonce={0} />);
      await settleTerminal();
      const rows = terminal.lastFrame().trimEnd().split('\n');
      expect(rows).toHaveLength(23);
      expect(rows.at(-1)).toContain(interactionCopy.interrupt);
      expect(rows.at(-2)).toContain(interactionCopy.generating[1]);
      expect(rows.slice(0, -2).join('\n')).not.toContain('Esc');
      expect(braille(terminal.lastFrame())).toBe(1);
      expect(braille(rows.at(-2)!)).toBe(1);
    } finally { terminal.dispose(); }
  });

  it('keeps the spinner fixed when the editor scrolls away and returns', async () => {
    const terminal = createTerminalHarness(80, 24);
    try {
      terminal.mount(<Frame nonce={0} />);
      await settleTerminal();
      expect(terminal.lastFrame()).toContain(interactionCopy.runningPlaceholder);
      let sawEditorOut = false;
      for (let step = 1; step <= 8; step += 1) {
        terminal.rerender(<Frame nonce={step} repeat={1} />);
        await settleTerminal();
        const frame = terminal.lastFrame();
        const rows = frame.trimEnd().split('\n');
        expect(rows).toHaveLength(23);
        expect(braille(frame), `step ${step}`).toBe(1);
        expect(braille(rows.at(-2)!)).toBe(1);
        expect(rows.at(-1)).toContain(interactionCopy.interrupt);
        if (!frame.includes(interactionCopy.runningPlaceholder)) sawEditorOut = true;
      }
      expect(sawEditorOut).toBe(false);
      terminal.rerender(<Frame nonce={20} kind="toBottom" />);
      await settleTerminal();
      const back = terminal.lastFrame();
      expect(back).toContain(interactionCopy.runningPlaceholder);
      expect(braille(back)).toBe(1);
      expect(braille(back.trimEnd().split('\n').at(-2)!)).toBe(1);
    } finally { terminal.dispose(); }
  });
});
