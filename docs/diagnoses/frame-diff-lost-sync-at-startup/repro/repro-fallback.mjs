/**
 * Minimal repro: "Frame diffing lost sync with the terminal and fell back to a
 * full repaint" raised at startup.
 *
 * This harness rebuilds the EXACT stdout stack `cli.tsx::runInteractive()`
 * builds (frame-differ -> stdout-frame-writer -> frame-observer -> Ink), runs a
 * real Ink render of an AppShell-shaped fixed-height frame, and classifies
 * every chunk the differ refuses.
 *
 * Two independent triggers are demonstrated:
 *   1. Ink 5.2.1's internal <App> componentDidMount writes the cursor-hide
 *      sequence `\x1b[?25l` THROUGH the wrapped stdout (components/App.js:92)
 *      — this fires on EVERY launch, no resize needed (the startup notice).
 *   2. Any shrink resize makes Ink abandon log-update (ink.js:121,
 *      outputHeight >= stdout.rows) and write `clearTerminal + frame` — an
 *      additional unrecognizable chunk.
 *
 * Run:  node docs/diagnoses/frame-diff-lost-sync-at-startup/repro/repro-fallback.mjs
 * (from the repo root; needs `npm install` and `npm run build -w packages/cli`.)
 */

import { EventEmitter } from 'node:events';
import React from 'react';
import { Box, Text, render } from 'ink';
import { createFrameDiffer } from '../../../../packages/cli/dist/ui/frame-differ.js';
import { wrapStdoutForFrames } from '../../../../packages/cli/dist/ui/stdout-frame-writer.js';
import { createFrameObserver } from '../../../../packages/cli/dist/ui/frame-observer.js';
import { createScrollbarBridge } from '../../../../packages/cli/dist/ui/scrollbar-controller.js';
import { frameHeight } from '../../../../packages/cli/dist/ui/layout/frame.js';

const NOTICE_TEXT =
  'Frame diffing lost sync with the terminal and fell back to a full repaint.';

/** A TTY-shaped stdout: rows/columns mutable, 'resize' emitted by the driver. */
class FakeTty extends EventEmitter {
  constructor(rows, columns) {
    super();
    this.rows = rows;
    this.columns = columns;
    this.isTTY = true;
  }
  write(chunk, _enc, cb) {
    if (typeof cb === 'function') cb();
    return true;
  }
}

/**
 * The AppShell shape from `ui/layout/AppShell.tsx`: a root Box pinned to
 * `frameHeight(rows)` = rows - 1 (invariant I-1), with a header row, a flex
 * viewport, a toast row and a status row. `tick` stands in for the live
 * spinner/clock that re-renders the real App a few times a second.
 */
function FullScreenFrame({ rows, cols, tick }) {
  return React.createElement(
    Box,
    { flexDirection: 'column', height: frameHeight(rows), width: cols, overflow: 'hidden' },
    React.createElement(Box, { height: 1, flexShrink: 0 }, React.createElement(Text, null, 'header')),
    React.createElement(
      Box,
      { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      React.createElement(Text, null, `viewport tick=${tick}`),
    ),
    React.createElement(Box, { height: 1, flexShrink: 0 }, React.createElement(Text, null, 'toast')),
    React.createElement(Box, { height: 1, flexShrink: 0 }, React.createElement(Text, null, 'status')),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classify(chunk) {
  if (chunk === '\x1b[?25l') return 'cursor-hide ESC[?25l  (ink App.componentDidMount -> cliCursor.hide(stdout))';
  if (chunk === '\x1b[?25h') return 'cursor-show ESC[?25h  (ink App.componentWillUnmount -> cliCursor.show(stdout))';
  if (chunk.startsWith('\x1b[2J\x1b[3J\x1b[H')) return 'clearTerminal ESC[2J ESC[3J ESC[H + frame (ink.js:121 tall-frame path)';
  return 'other: ' + JSON.stringify(chunk.slice(0, 24));
}

async function runScenario({ name, startRows, endRows, settleMs = 120 }) {
  const tty = new FakeTty(startRows, 100);
  const notices = [];
  const rejectedChunks = [];

  // --- cli.tsx:672-716, verbatim structure -------------------------------
  const differ = createFrameDiffer({
    sync: true,
    rows: () => tty.rows,
    cols: () => tty.columns,
    onFirstFallback: () => notices.push(NOTICE_TEXT),
  });
  const frameWriter = wrapStdoutForFrames(tty, differ);
  const scrollbar = createScrollbarBridge(() => false);
  const frameObserver = createFrameObserver({
    stdout: frameWriter.stdout,
    terminal: tty,
    scrollbar,
  });

  // Instrument: keep every chunk the differ refused (the "foreign" writes).
  const realTransform = differ.transform;
  differ.transform = (chunk) => {
    const out = realTransform(chunk);
    if (out === null) rejectedChunks.push(chunk);
    return out;
  };

  // --- a ticking App, like the real one (spinner/clock re-renders) -------
  let tick = 0;
  let instance;
  const App = () => {
    const [size, setSize] = React.useState({ rows: tty.rows, cols: tty.columns });
    React.useEffect(() => {
      const onResize = () => setTimeout(() => setSize({ rows: tty.rows, cols: tty.columns }), 50);
      tty.on('resize', onResize);
      return () => tty.off('resize', onResize);
    }, []);
    return React.createElement(FullScreenFrame, { rows: size.rows, cols: size.cols, tick });
  };
  const timer = setInterval(() => { tick += 1; }, 60);
  try {
    instance = render(React.createElement(App), {
      exitOnCtrlC: false,
      patchConsole: false,
      stdout: frameObserver.stdout,
    });

    await sleep(settleMs); // let a few frames paint
    const startupFallbacks = differ.stats().fallbacks;

    // --- optional trigger: the terminal shrinks (pane settles, host resyncs,
    //     user nudges the window, font/DPI change, ...).
    if (endRows !== startRows) {
      tty.rows = endRows;
      tty.emit('resize');
    }
    await sleep(settleMs + 100); // past useTerminalSize's 50 ms debounce

    const after = differ.stats();
    console.log(`\n=== ${name} (${startRows} -> ${endRows} rows) ===`);
    console.log(`  frames: total=${after.framesTotal} diffed=${after.framesDiffed} full=${after.framesFull}`);
    console.log(`  fallbacks: at-startup=${startupFallbacks} after-resize=${after.fallbacks - startupFallbacks}`);
    console.log(`  notice raised: ${notices.length > 0 ? 'YES  <-- user-visible bug' : 'no'}`);
    console.log(`  chunks the differ refused (${rejectedChunks.length}):`);
    for (const c of rejectedChunks) console.log(`    - ${classify(c)}`);
    return { fallbacks: after.fallbacks, notice: notices.length > 0 };
  } finally {
    clearInterval(timer);
    instance?.unmount();
    frameObserver.dispose();
    frameWriter.dispose();
  }
}

const steady = await runScenario({ name: 'no resize', startRows: 24, endRows: 24 });
const shrink = await runScenario({ name: 'SHRINK by 1 row', startRows: 24, endRows: 23 });
const grow = await runScenario({ name: 'GROW by 6 rows (control)', startRows: 24, endRows: 30 });

console.log('\n=== verdict ===');
console.log(`no-resize session raised the notice : ${steady.notice}  (deterministic startup bug)`);
console.log(`one-row shrink raised the notice    : ${shrink.notice}  (shrink adds another fallback)`);
console.log(`grow-only session raised the notice : ${grow.notice}  (cursor-hide fallback present too)`);
console.log(
  `\nRoot cause: Ink 5.2.1's internal <App> writes the cursor-hide sequence\n` +
    `'\\x1b[?25l' through the render stdout (components/App.js:92) as the session's\n` +
    `second chunk. frame-differ.ts treats it as a foreign write: passThrough(true)\n` +
    `-> fallbacks 0->1 -> onFirstFallback -> console.warn(FRAME_FALLBACK_NOTICE).`,
);
