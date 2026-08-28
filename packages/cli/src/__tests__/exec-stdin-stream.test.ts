/**
 * `--input-format stream-json` (cli-integration-surface section 4.1 / AC-20).
 *
 * TOLERANCE IS THE CONTRACT. The schema promises consumers that unknown event
 * types and unknown fields are ignored; that promise has to run in BOTH
 * directions, or a caller written against a newer CLI could not talk to an older
 * one at all. And a long-lived worker feeding turns down a pipe must not die on
 * one bad line.
 */

import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createStdinPromptSource, prefixSource } from '../exec/stdin-stream.js';
import { singlePrompt } from '../exec/runner.js';

function feed(lines: string): {
  source: ReturnType<typeof createStdinPromptSource>;
  bad: string[];
  interrupts: () => number;
} {
  const bad: string[] = [];
  let interrupts = 0;
  const source = createStdinPromptSource({
    input: Readable.from([lines]),
    onBadLine: (m) => bad.push(m),
    onInterrupt: () => {
      interrupts += 1;
    },
  });
  return { source, bad, interrupts: () => interrupts };
}

async function drain(source: { next(): Promise<string | null> }): Promise<string[]> {
  const out: string[] = [];
  for (;;) {
    const next = await source.next();
    if (next === null) return out;
    out.push(next);
  }
}

describe('AC-20: three turns from one process', () => {
  it('yields each `user` message in order and then ends', async () => {
    const { source } = feed(
      [
        '{"type":"user","text":"one"}',
        '{"type":"user","text":"two"}',
        '{"type":"user","text":"three"}',
        '',
      ].join('\n'),
    );
    expect(await drain(source)).toEqual(['one', 'two', 'three']);
  });

  it('ends on an explicit `end` message', async () => {
    const { source } = feed(
      ['{"type":"user","text":"one"}', '{"type":"end"}', '{"type":"user","text":"never"}', ''].join(
        '\n',
      ),
    );
    expect(await drain(source)).toEqual(['one']);
  });

  it('accepts a final line with no trailing newline', async () => {
    const { source } = feed('{"type":"user","text":"only"}');
    expect(await drain(source)).toEqual(['only']);
  });
});

describe('AC-20: a malformed line is skipped, not fatal', () => {
  it('reports it once and keeps reading', async () => {
    const { source, bad } = feed(
      ['{"type":"user","text":"one"}', '{ not json', '{"type":"user","text":"two"}', ''].join('\n'),
    );
    expect(await drain(source)).toEqual(['one', 'two']);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain('not JSON');
  });

  it('reports a `user` message with no usable text', async () => {
    const { source, bad } = feed(
      ['{"type":"user"}', '{"type":"user","text":"   "}', '{"type":"user","text":"ok"}', ''].join(
        '\n',
      ),
    );
    expect(await drain(source)).toEqual(['ok']);
    expect(bad).toHaveLength(2);
  });

  it('IGNORES an unknown type silently', async () => {
    // Reporting it would make every additive change to the schema noisy for
    // callers running an older CLI - which is the opposite of what the forward
    // compatibility contract is for.
    const { source, bad } = feed(
      ['{"type":"telemetry","x":1}', '{"type":"user","text":"ok"}', ''].join('\n'),
    );
    expect(await drain(source)).toEqual(['ok']);
    expect(bad).toEqual([]);
  });

  it('tolerates blank lines and a JSON scalar', async () => {
    const { source, bad } = feed(['', '42', '{"type":"user","text":"ok"}', ''].join('\n'));
    expect(await drain(source)).toEqual(['ok']);
    expect(bad).toHaveLength(1);
  });
});

describe('interrupts arrive through their own channel', () => {
  it('calls the handler and does not yield a turn', async () => {
    const { source, interrupts } = feed(
      ['{"type":"interrupt"}', '{"type":"user","text":"after"}', ''].join('\n'),
    );
    expect(await drain(source)).toEqual(['after']);
    expect(interrupts()).toBe(1);
  });
});

describe('prefixSource', () => {
  it('serves the positional argument first, then the stream', async () => {
    const { source } = feed(['{"type":"user","text":"second"}', ''].join('\n'));
    expect(await drain(prefixSource(['first'], source))).toEqual(['first', 'second']);
  });

  it('degenerates to the prefix when the stream is empty', async () => {
    expect(await drain(prefixSource(['only'], feed('').source))).toEqual(['only']);
  });

  it('and `singlePrompt` serves exactly once', async () => {
    expect(await drain(singlePrompt('one shot'))).toEqual(['one shot']);
  });
});
