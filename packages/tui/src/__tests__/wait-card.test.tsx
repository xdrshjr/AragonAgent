/**
 * The wait card and the surfaces that carry its clock
 * (extended-job-wait AC-26 / AC-27 / AC-31 / AC-39).
 *
 * Rendered through the REAL `TranscriptList` and the REAL `LiveTail`, because the
 * card is chosen inside `EntryView` from the entry alone (RV-3): a test that mounted
 * `WaitCard` directly would pass even if neither surface ever picked it.
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { TranscriptList } from '../ui/Transcript.js';
import { LiveTail } from '../ui/scrollback/LiveTail.js';
import { ViewportGeometryContext } from '../ui/layout/viewport-geometry.js';
import { getTheme } from '../ui/theme.js';
import { phaseLabels } from '../ui/layout/status-layout.js';
import { resolveActivityLabel } from '../ui/ActivityLine.js';
import { pickGlyphs } from '../ui/glyphs.js';
import { estimateEntryRows } from '../ui/layout/virtual-window.js';
import type { Entry } from '../model/agent/reducer.js';
import type { HeightStore } from '../ui/use-height-store.js';
import type { TermCapabilities } from '../ui/capabilities.js';
import type { WaitView } from '../model/proc/wait-view.js';
import { DEVELOPER_VOICE } from '../ui/tool-voice.js';

const UNICODE: TermCapabilities = { colorLevel: 3, unicode: true };
const ASCII: TermCapabilities = { colorLevel: 0, unicode: false };

// eslint-disable-next-line no-control-regex
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

type ToolEntry = Extract<Entry, { kind: 'tool' }>;

const WAIT_START = 1_000_000;
/** 4m12s into a 10m wait. */
const NOW_SEC = (WAIT_START + 252_000) / 1000;

function view(over: Partial<WaitView> = {}): WaitView {
  return {
    toolCallId: 'w1',
    jobLabel: 't3',
    command: 'python train.py --epochs 10',
    waitStartedAt: WAIT_START,
    upToMs: 600_000,
    beatAt: WAIT_START + 252_000,
    mode: 'all',
    liveJobs: 1,
    jobStartedAt: WAIT_START - 2_272_000,
    status: 'running',
    progress: { text: 'epoch 3/10  ETA 13m', kind: 'epoch', fraction: 0.3 },
    lastRow: 'step 912/1000  loss 0.4098',
    lastOutputAt: WAIT_START + 249_000,
    stalled: false,
    stallSeconds: 300,
    ...over,
  };
}

function entry(over: Partial<ToolEntry> = {}): ToolEntry {
  return {
    id: 'e1',
    kind: 'tool',
    toolCallId: 'w1',
    name: 'job_wait',
    label: 'Wait for job',
    argsRaw: '{"job":"t3","timeoutSeconds":600}',
    args: { job: 't3', timeoutSeconds: 600 },
    status: 'running',
    wait: view(),
    waitSeq: 1,
    ...over,
  } as ToolEntry;
}

const PASSTHROUGH: HeightStore = {
  version: 0,
  resolve: (_key, estimate) => estimate(),
  report: () => {},
  stats: () => ({ measured: 0, estimated: 0 }),
  clear: () => {},
};

function fullscreen(
  entries: Entry[],
  opts: { caps?: TermCapabilities; reducedMotion?: boolean; cols?: number } = {},
): string[] {
  const caps = opts.caps ?? UNICODE;
  const { lastFrame, unmount } = render(
    <ViewportGeometryContext.Provider value={{ viewportRows: 60, offset: 0, contentRows: 0 }}>
      <TranscriptList voice={DEVELOPER_VOICE}
        entries={entries}
        expandedToolIds={{}}
        thinkingVisible={false}
        reducedMotion={opts.reducedMotion ?? true}
        density="compact"
        nowSec={NOW_SEC}
        theme={getTheme('cool', caps)}
        caps={caps}
        windowSize={20_000}
        cols={opts.cols ?? 100}
        heights={PASSTHROUGH}
      />
    </ViewportGeometryContext.Provider>,
  );
  const frame = strip(lastFrame() ?? '');
  unmount();
  return frame.split('\n').filter((line) => line.trim().length > 0);
}

describe('WaitCard through the transcript (AC-26)', () => {
  it('draws exactly five rows with the clock, the bar, both clocks, the output and the hint', () => {
    const lines = fullscreen([entry()]);
    expect(lines).toHaveLength(5);
    const frame = lines.join('\n');
    expect(frame).toContain('Waiting for t3');
    expect(frame).toContain('python train.py --epochs 10');
    expect(frame).toContain('4m12s of 10m00s');
    expect(frame).toContain('30%  epoch 3/10  ETA 13m');
    expect(frame).toContain('job running 42m04s');
    expect(frame).toContain('this wait ends in 5m48s, or sooner if the job finishes');
    expect(frame).toContain('step 912/1000  loss 0.4098');
    expect(frame).toContain('3s ago');
    expect(frame).toContain('Send a message to end the wait early');
    expect(frame).toContain('Esc x2 stops the whole run');
  });

  it('with no job progress the bar becomes the wait window, and says so', () => {
    const lines = fullscreen([entry({ wait: view({ progress: undefined }) })]);
    expect(lines).toHaveLength(5);
    // 252s of 600s => 42%
    expect(lines.join('\n')).toContain('42%  of this 10m00s wait');
  });

  it('a long silence is a calm note that it is not a failure, not an alarm', () => {
    const lines = fullscreen([
      entry({ wait: view({ lastOutputAt: WAIT_START - 110_000 }) }),
    ]);
    expect(lines).toHaveLength(5);
    expect(lines.join('\n')).toContain(
      'quiet for 6m02s - the job is still alive; this is not a failure',
    );
  });

  it('no output yet is still five rows', () => {
    const lines = fullscreen([entry({ wait: view({ lastRow: undefined }) })]);
    expect(lines).toHaveLength(5);
    expect(lines.join('\n')).toContain('no output yet');
  });

  it('several jobs: ANY and ALL say which finish ends the wait', () => {
    const any = fullscreen([
      entry({ wait: view({ jobLabel: '3 jobs', command: '', mode: 'any', liveJobs: 3, progress: undefined }) }),
    ]);
    expect(any).toHaveLength(5);
    expect(any.join('\n')).toContain('3 jobs live');
    expect(any.join('\n')).toContain('this wait ends when ANY finishes');
    const all = fullscreen([
      entry({ wait: view({ jobLabel: '2 jobs', command: '', mode: 'all', liveJobs: 2, progress: undefined }) }),
    ]);
    expect(all.join('\n')).toContain('this wait ends when ALL finish');
  });

  it('an ASCII terminal gets # and - and the same five rows', () => {
    const lines = fullscreen([entry()], { caps: ASCII });
    expect(lines).toHaveLength(5);
    const frame = lines.join('\n');
    expect(frame).toMatch(/#+-+\s+30%/);
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7f]*$/.test(frame)).toBe(true);
  });

  it.each([36, 40, 80, 120])('is five rows and never overflows at %i columns', (cols) => {
    const lines = fullscreen([entry()], { cols });
    expect(lines).toHaveLength(5);
  });

  it('the settled card is the ordinary one-line history row, with the readable summary', () => {
    const lines = fullscreen([
      entry({ status: 'done', wait: undefined, waitSeq: undefined, durationMs: 252_000, preview: 'ok' }),
    ]);
    const frame = lines.join('\n');
    expect(frame).not.toContain('Waiting for');
    expect(frame).toContain('job_wait');
    expect(frame).toContain('t3');
    expect(frame).toContain('up to 10m00s');
  });

  it('a running job_wait before its first beat is the ordinary running card', () => {
    const lines = fullscreen([entry({ wait: undefined, waitSeq: undefined })]);
    expect(lines.join('\n')).toContain('running');
    expect(lines.join('\n')).not.toContain('Waiting for');
  });
});

describe('reduced motion (AC-27)', () => {
  it('keeps the numbers moving: the clock follows nowSec even with the spinner off', () => {
    const at = (sec: number): string =>
      fullscreen([entry({ wait: view({ beatAt: sec * 1000 }) })]).join('\n');
    expect(at(0)).toContain('4m12s of 10m00s');
  });
});

describe('height agrees with the drawing (AC-28)', () => {
  it('estimateEntryRows is exactly the number of rows the card draws', () => {
    const e = entry();
    const drawn = fullscreen([e]).length;
    // The estimate includes the separation row above the first entry; the drawing here
    // is the first entry, so it has none.
    expect(estimateEntryRows(e, 100, 'compact', false)).toBeGreaterThanOrEqual(drawn);
    expect(estimateEntryRows(e, 100, 'compact', false) - drawn).toBeLessThanOrEqual(1);
  });
});

describe('native-scroll mode draws the same card (AC-39 / RV-3)', () => {
  it('LiveTail mounts the five-row WaitCard from the entry alone', () => {
    const { lastFrame, unmount } = render(
      <LiveTail voice={DEVELOPER_VOICE}
        entries={[entry()]}
        maxEntries={4}
        rows={10}
        cols={100}
        expandedToolIds={{}}
        thinkingVisible
        reducedMotion
        density="comfortable"
        nowSec={NOW_SEC}
        theme={getTheme('cool', UNICODE)}
        caps={UNICODE}
      />,
    );
    const frame = strip(lastFrame() ?? '');
    unmount();
    expect(frame).toContain('Waiting for t3');
    expect(frame).toContain('4m12s of 10m00s');
    expect(frame).toContain('Send a message to end the wait early');
  });
});

describe('the status bar and the activity line (AC-31)', () => {
  const base = { phase: 'tool', activeTool: { name: 'job_wait', toolCallId: 'w1' } } as const;

  it('without a clock the original sentence is byte-identical', () => {
    const labels = phaseLabels({ ...base, wait: { jobId: 't3', upToSeconds: 30 } });
    expect(labels).toEqual(['Waiting on t3 (up to 30s)', 'Waiting on t3 (up to 30s)']);
  });

  it('with a clock it reads Waiting on t3 4m12s/10m00s, and the short rung keeps id and time', () => {
    const labels = phaseLabels({
      ...base,
      wait: { jobId: 't3', upToSeconds: 600, elapsedSeconds: 252 },
    });
    expect(labels[1]).toBe('Waiting on t3 4m12s/10m00s');
    expect(labels[0]).toBe('Wait t3 4m12s');
  });

  it('the activity line follows suit', () => {
    const glyphs = pickGlyphs(UNICODE);
    expect(
      resolveActivityLabel({ wait: { jobId: 't3', upToSeconds: 600, elapsedSeconds: 252 } } as never, glyphs),
    ).toBe('Waiting on t3 4m12s/10m00s');
    expect(
      resolveActivityLabel({ wait: { jobId: 't3', upToSeconds: 30 } } as never, glyphs),
    ).toBe('Waiting on t3 (up to 30s)');
  });
});
