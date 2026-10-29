/**
 * A rail box (`railBorderProps`) that is re-rendered IN PLACE must be exactly as tall and as
 * wide as the same box mounted fresh.
 *
 * Why it matters: Ink applies only the changed style keys on update, and a changed
 * `borderStyle` makes `applyBorderStyles` re-open the disabled top/bottom/right edges. The
 * live region then drew two phantom rows per rail box that the offscreen renderer (always a
 * fresh mount) never counted, so the scrollback print arithmetic came up short and the head
 * of a tall final reply was lost. `railBorderProps` now hands out one frozen style object per
 * rail glyph, which is what makes the in-place update and the fresh mount agree.
 */
import React from 'react';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Box, Text, render } from 'ink';
import stripAnsi from 'strip-ansi';
import type { Entry } from '../model/agent/reducer.js';
import { getTheme } from '../ui/theme.js';
import type { TermCapabilities } from '../ui/capabilities.js';
import { LiveTail } from '../ui/scrollback/LiveTail.js';
import { railBorderProps } from '../ui/layout/Gutter.js';
import { DEVELOPER_VOICE } from '../ui/tool-voice.js';

const CAPS: TermCapabilities = { colorLevel: 0, unicode: false };
const THEME = getTheme('cool', CAPS);

/** One resident Ink instance writing to a fake stdout: `show()` re-renders IN PLACE. */
function session() {
  let last = '';
  const stdout = Object.assign(new EventEmitter(), {
    columns: 80, rows: 1000, isTTY: false,
    write(chunk: string): boolean { last = chunk; return true; },
  }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: false, setEncoding() {}, resume() {}, pause() {}, ref() {}, unref() {},
  }) as unknown as NodeJS.ReadStream;
  const instance = render(null, {
    stdout, stdin, stderr: stdout, debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  return {
    show(node: React.ReactElement): string[] {
      instance.rerender(node);
      return last.split('\n').map(stripAnsi);
    },
    end(): void { instance.unmount(); instance.cleanup(); },
  };
}

/** Rows of `node` after it was shown `steps.length` times in the SAME instance. */
function updatedRows(steps: React.ReactElement[]): string[] {
  const s = session();
  let rows: string[] = [];
  for (const step of steps) rows = s.show(step);
  s.end();
  return rows.filter((row) => row.trim() !== '');
}

function freshRows(node: React.ReactElement): string[] {
  const s = session();
  const rows = s.show(node);
  s.end();
  return rows.filter((row) => row.trim() !== '');
}

const tail = (entry: Entry): React.ReactElement => (
  <LiveTail entries={[entry]} maxEntries={10} rows={40} cols={78} expandedToolIds={{}}
    thinkingVisible={false} reducedMotion voice={DEVELOPER_VOICE} density="comfortable"
    theme={THEME} caps={CAPS} />
);

const assistant = (text: string, streaming: boolean): Entry =>
  ({ id: 'a', kind: 'assistant', text, thinkingOpen: false, streaming });

describe('a rail box re-rendered in place vs mounted fresh', () => {
  it('1. markdown code block: streamed answer is 2 rows taller than a fresh render', () => {
    const parts = ['plain A\n', '```ts\n', 'const x = 1;\n', '```\n', 'tail B\n'];
    let acc = '';
    const steps = parts.map((part) => { acc += part; return tail(assistant(acc, true)); });
    steps.push(tail(assistant(acc, false)));
    const updated = updatedRows(steps);
    const fresh = freshRows(tail(assistant(acc, false)));
    expect(updated).toEqual(fresh);
  });

  it('2. tool card that ran with a live tail, then finished', () => {
    const tool = (status: 'running' | 'done', liveLines: number): Entry => ({
      id: 't', kind: 'tool', toolCallId: 'c', name: 'bash', label: 'run tests',
      argsRaw: '{"command":"npm test"}', args: { command: 'npm test' }, status,
      ...(status === 'running'
        ? { live: Array.from({ length: liveLines }, (_, i) => `out ${i}`), liveSeq: liveLines }
        : { preview: 'PASS a\nPASS b\nPASS c', duration: 1200 }),
    } as Entry);
    const updated = updatedRows([tail(tool('running', 1)), tail(tool('running', 2)),
      tail(tool('running', 3)), tail(tool('done', 0))]);
    const fresh = freshRows(tail(tool('done', 0)));
    expect(updated).toEqual(fresh);
  });

  it('3. width: a rail box loses one column to a phantom right border after an update', () => {
    // 77 'x' fit on one row of a 78-column box next to a 1-column rail + 1 padding column;
    // one column fewer and the row wraps.
    const long = 'x'.repeat(74);
    const code = `\`\`\`\n${long}\n\`\`\`\n`;
    const updated = updatedRows([tail(assistant('a\n', true)), tail(assistant(`a\n${code}`, true)),
      tail(assistant(`a\n${code}`, false))]);
    const fresh = freshRows(tail(assistant(`a\n${code}`, false)));
    expect(updated.length).toBe(fresh.length);
  });

  it('4. control: the same box with a memoised borderStyle does not drift', () => {
    const border = railBorderProps('|');
    const stable = { ...border };
    const mk = (text: string): React.ReactElement => (
      <Box flexDirection="column" paddingLeft={1} {...stable}>
        <Text>{text}</Text>
      </Box>
    );
    const updated = updatedRows([mk('one'), mk('one\ntwo'), mk('one\ntwo\nthree')]);
    const fresh = freshRows(mk('one\ntwo\nthree'));
    expect(updated).toEqual(fresh);
  });
});
