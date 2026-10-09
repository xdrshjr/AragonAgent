/** Trace: who writes each chunk through the differ-wrapped stdout, with stacks. */
import { EventEmitter } from 'node:events';
import React from 'react';
import { Box, Text, render } from 'ink';
import { createFrameDiffer } from '../../../../packages/cli/dist/ui/frame-differ.js';
import { wrapStdoutForFrames } from '../../../../packages/cli/dist/ui/stdout-frame-writer.js';
import { createFrameObserver } from '../../../../packages/cli/dist/ui/frame-observer.js';
import { createScrollbarBridge } from '../../../../packages/cli/dist/ui/scrollbar-controller.js';
import { frameHeight } from '../../../../packages/cli/dist/ui/layout/frame.js';

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

function Frame({ rows, cols }) {
  return React.createElement(
    Box,
    { flexDirection: 'column', height: frameHeight(rows), width: cols, overflow: 'hidden' },
    React.createElement(Box, { height: 1 }, React.createElement(Text, null, 'header')),
    React.createElement(Box, { flexGrow: 1 }, React.createElement(Text, null, 'viewport')),
    React.createElement(Box, { height: 1 }, React.createElement(Text, null, 'status')),
  );
}

const tty = new FakeTty(24, 100);
const differ = createFrameDiffer({ sync: true, rows: () => tty.rows, cols: () => tty.columns });
const frameWriter = wrapStdoutForFrames(tty, differ);
const scrollbar = createScrollbarBridge(() => false);
const frameObserver = createFrameObserver({ stdout: frameWriter.stdout, terminal: tty, scrollbar });

let n = 0;
const realTransform = differ.transform;
differ.transform = (chunk) => {
  n += 1;
  const out = realTransform(chunk);
  const head = chunk.slice(0, 20).replace(/\x1b/g, 'ESC').replace(/\n/g, '\\n');
  const stack = new Error().stack.split('\n').slice(2, 7).join('\n    ');
  console.log(`#${n} ${out === null ? 'REJECTED(pass-through)' : 'transformed'} ${JSON.stringify(head)}`);
  console.log(`    ${stack}`);
  return out;
};

const App = () => {
  const [size, setSize] = React.useState({ rows: tty.rows, cols: tty.columns });
  React.useEffect(() => {
    const onResize = () => setTimeout(() => setSize({ rows: tty.rows, cols: tty.columns }), 50);
    tty.on('resize', onResize);
    return () => tty.off('resize', onResize);
  }, []);
  return React.createElement(Frame, size);
};

let instance;
try {
  instance = render(React.createElement(App), {
    exitOnCtrlC: false,
    patchConsole: false,
    stdout: frameObserver.stdout,
  });
  await new Promise((r) => setTimeout(r, 250));
  console.log(`\nstats: ${JSON.stringify(differ.stats())}`);
} finally {
  instance?.unmount();
  frameObserver.dispose();
  frameWriter.dispose();
}
