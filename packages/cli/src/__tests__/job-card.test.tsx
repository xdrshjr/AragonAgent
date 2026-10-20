import React from 'react';
import { Box } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ServiceCard } from '../ui/entries/ServiceCard.js';
import { getTheme } from '../ui/theme.js';
import { detectCapabilities } from '../ui/capabilities.js';
import { estimateEntryRows } from '../ui/layout/virtual-window.js';
import type { Entry } from '../agent/reducer.js';

const caps = detectCapabilities({}, process.stdout);
const theme = getTheme('dark', caps);

/** A wide box, so the assertion is about the card's wording and not the width. */
function frameOf(node: React.ReactElement): string {
  return render(<Box width={200}>{node}</Box>).lastFrame() ?? '';
}

function props(over: Record<string, unknown> = {}) {
  return {
    serviceId: 't1',
    jobKind: 'task' as const,
    command: 'python train.py',
    status: 'running' as const,
    exitCode: null,
    startedAt: 1_000,
    rows: ['step 900/1000  loss 0.4101'],
    theme,
    caps,
    ...over,
  };
}

describe('ServiceCard: the task shape', () => {
  it('AC-26: a task card says "task" and draws the progress row', () => {
    const frame = frameOf(<ServiceCard {...props({ command: 'train.py', progress: '47%' })} />);
    expect(frame).toContain('task t1');
    expect(frame).toContain('train.py');
    expect(frame).toContain('running');
    expect(frame).toContain('[progress] 47%');
  });

  it('AC-26: the elapsed figure comes from `nowSec`, not from a timer', () => {
    // `startedAt: 0`, `nowSec: 724` => exactly 12m04s.
    const frame = frameOf(
      <ServiceCard {...props({ command: 'train.py', startedAt: 0, nowSec: 724 })} />,
    );
    expect(frame).toContain('12m04s');
  });

  it('a service card keeps its noun and its status words', () => {
    const frame = frameOf(
      <ServiceCard {...props({ serviceId: 's1', jobKind: 'service', command: 'serve' })} />,
    );
    expect(frame).toContain('service s1');
    expect(frame).toContain('running');
  });

  it('AC-26: stalled replaces the progress row with a quiet badge', () => {
    const frame = frameOf(
      <ServiceCard
        {...props({
          command: 'train.py',
          progress: '47%',
          stalled: true,
          lastOutputAt: 0,
          nowSec: 362,
        })}
      />,
    );
    expect(frame).toContain('no output 6m02s');
    expect(frame).not.toContain('[progress]');
  });

  it('AC-26: the terminal record is still exactly one row', () => {
    const frame = frameOf(
      <ServiceCard
        {...props({ command: 'train.py', terminal: true, status: 'exited', exitCode: 0, endedAt: 500 })}
      />,
    );
    const lines = frame.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('task t1');
    expect(lines[0]).toContain('exited code 0');
  });

  it('AC-27: the estimator counts the progress row the card actually draws', () => {
    const entry = {
      id: '1',
      kind: 'service',
      serviceId: 't1',
      jobKind: 'task',
      command: 'python train.py',
      status: 'running',
      exitCode: null,
      startedAt: 1_000,
      rows: ['a', 'b'],
      rowsSeen: 2,
      lastOutputAt: 1_000,
      progress: '47%',
    } as unknown as Entry;
    const withProgress = estimateEntryRows(entry, 100, 'comfortable', false);
    const without = estimateEntryRows(
      { ...entry, progress: undefined } as unknown as Entry,
      100,
      'comfortable',
      false,
    );
    expect(withProgress - without).toBe(1);
    // And the real card agrees: one more drawn line than the same card without it.
    const drawn = frameOf(<ServiceCard {...props({ progress: '47%' })} />)
      .split('\n').filter((line) => line.length > 0).length;
    const drawnWithout = frameOf(<ServiceCard {...props()} />)
      .split('\n').filter((line) => line.length > 0).length;
    expect(drawn - drawnWithout).toBe(1);
  });

  it('the elapsed figure does not move without a clock (D-8: one clock, no timers)', () => {
    // Without `nowSec` the clause is `running` with no figure rather than a
    // number that silently freezes at the spawn time.
    const frame = frameOf(<ServiceCard {...props()} />);
    expect(frame).toContain('running');
    expect(frame).not.toContain('0ms');
  });
});
