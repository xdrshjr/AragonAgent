/**
 * The `service` entry kind, across the five closed switches it has to be added
 * to (§7.6 / AC-39, AC-40) and the card itself (AC-24, AC-25).
 *
 * EVERY ASSERTION HERE FAILS ON A BUILD THAT ADDED THE KIND TO ONLY ONE PLACE,
 * AND NONE OF THOSE FAILURES IS OTHERWISE VISIBLE. `entryRevision` and
 * `estimateEntryRows` both have a `default` that swallows an unknown kind;
 * `renderEntry` returns `[]`; `computeSettledCount` simply keeps counting. A
 * frozen card, a mis-windowed card, a card missing from the exit snapshot and a
 * transcript that re-renders forever are what those four look like in
 * production.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import type { Entry } from '../agent/reducer.js';
import { viewReducer, initialViewState } from '../agent/reducer.js';
import { entryRevision, estimateEntryRows } from '../ui/layout/virtual-window.js';
import { computeSettledCount, EntryView } from '../ui/Transcript.js';
import { renderTranscriptText } from '../ui/transcript-text.js';
import { pickGlyphs } from '../ui/glyphs.js';
import { getTheme } from '../ui/theme.js';
import { normalizeLoadedEntries } from '../session/persist.js';
import type { ServiceSnapshot } from '../proc/types.js';

const CAPS = { colorLevel: 3 as const, unicode: true };
const THEME = getTheme('auto', CAPS);
const GLYPHS = pickGlyphs(CAPS);

function service(over: Partial<Extract<Entry, { kind: 'service' }>> = {}): Entry {
  return {
    id: 'e1',
    kind: 'service',
    serviceId: 's1',
    command: 'npm run dev',
    status: 'ready',
    url: 'http://localhost:3000',
    exitCode: null,
    startedAt: 1000,
    readyAt: 2400,
    rows: ['> next dev', '  - Local: http://localhost:3000'],
    rowsSeen: 2,
    ...over,
  };
}

function snapshot(over: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    id: 's1',
    toolCallId: 'call-1',
    command: 'npm run dev',
    cwd: '/tmp',
    pid: 123,
    status: 'starting',
    startedAt: 1000,
    exitCode: null,
    signal: null,
    rows: [],
    rowsSeen: 0,
    truncated: false,
    ...over,
  };
}

describe('AC-39: the three silent switches', () => {
  it('entryRevision changes when the STATUS changes', () => {
    const a = entryRevision(service({ status: 'starting' }));
    const b = entryRevision(service({ status: 'ready' }));
    expect(a).not.toBe(b);
  });

  it('entryRevision changes when a row is appended to a FULL ring', () => {
    // THE P0-3 PROPERTY. The tail evicts its oldest row while appending a new
    // one, so `rows.length` is IDENTICAL across two different tails - which is
    // exactly the non-append mutation `virtual-window.ts`'s I-L3-1 forbids
    // leaving out. A length-based term would go on matching while the card
    // changed underneath it, and the card would freeze at a stale height AND a
    // stale rendered subtree with nothing reporting it.
    const before = service({ rows: ['a', 'b'], rowsSeen: 2 });
    const after = service({ rows: ['b', 'c'], rowsSeen: 3 });
    expect(after.kind === 'service' && before.kind === 'service').toBe(true);
    expect((before as Extract<Entry, { kind: 'service' }>).rows.length).toBe(
      (after as Extract<Entry, { kind: 'service' }>).rows.length,
    );
    expect(entryRevision(before)).not.toBe(entryRevision(after));
  });

  it('entryRevision is not the `default` branch', () => {
    // The `default` returns a constant, so a missing clause is invisible except
    // by comparing against a kind that is definitely handled.
    expect(entryRevision(service())).not.toBe('x');
  });

  it('estimateEntryRows returns MORE than one row for a multi-row card', () => {
    const rows = estimateEntryRows(service(), 100, 'compact', false);
    // Status row + URL row + two tail rows, versus the `default`'s
    // `separation + 1`, which would window a four-row card as one - and an
    // entry estimated too short is mis-clamped or never mounted, so the
    // estimate never self-corrects.
    expect(rows).toBeGreaterThan(1);
  });

  it('estimateEntryRows charges exactly one row for the TERMINAL record', () => {
    expect(estimateEntryRows(service({ terminal: true, rows: [] }), 100, 'compact', false)).toBe(1);
  });

  it('renderTranscriptText emits a non-empty line for a service entry', () => {
    // `renderEntry`'s `default: return []` means a missing clause DROPS service
    // cards from the exit snapshot printed on quit - the user's only record once
    // the alternate screen is torn down.
    const text = renderTranscriptText([service()], {
      glyphs: GLYPHS,
      usageTotal: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      model: 'm',
      provider: 'p',
      elapsedMs: 0,
    });
    expect(text).toContain('service s1');
    expect(text).toContain('npm run dev');
    expect(text).toContain('http://localhost:3000');
  });
});

describe('AC-40: the settled boundary (D-11)', () => {
  const filler = (n: number): Entry[] =>
    Array.from({ length: n }, (_, i) => ({ id: `f${i}`, kind: 'notice', level: 'info', text: 'x' }));

  it('a READY service does NOT block the boundary', () => {
    // THIS IS THE ASSERTION THAT KEEPS A DEV SERVER LEFT UP FOR AN HOUR FROM
    // RE-RENDERING THE WHOLE TRANSCRIPT EVERY FRAME. Every other live clause in
    // `computeSettledCount` is bounded by an OPERATION; a service is bounded by
    // the user's intent, and treating the two alike pins the prefix scan at the
    // card for the rest of the session.
    const entries = [service({ status: 'ready' }), ...filler(50)];
    expect(computeSettledCount(entries, {})).toBeGreaterThan(1);
  });

  it('a RUNNING service does not block it either', () => {
    const entries = [service({ status: 'running', url: undefined }), ...filler(50)];
    expect(computeSettledCount(entries, {})).toBeGreaterThan(1);
  });

  it('a STARTING service DOES block it', () => {
    // The one status that is bounded by an operation - `readyTimeoutMs`, after
    // which the supervisor calls it `running` whatever happened - which is the
    // same shape as every other clause in that scan.
    const entries = [service({ status: 'starting', url: undefined }), ...filler(50)];
    expect(computeSettledCount(entries, {})).toBe(0);
  });
});

describe('AC-24 / AC-25: the card', () => {
  const draw = (entry: Entry): string => {
    const { lastFrame } = render(
      <EntryView
        entry={entry}
        prev={undefined}
        expanded={false}
        thinkingVisible={false}
        reducedMotion={false}
        density="compact"
        mode="fullscreen"
        theme={THEME}
        caps={CAPS}
      />,
    );
    return lastFrame() ?? '';
  };

  it('AC-24: each status renders its own row, and ready shows the URL', () => {
    expect(draw(service({ status: 'starting', url: undefined }))).toContain('starting');
    const ready = draw(service({ status: 'ready' }));
    expect(ready).toContain('ready');
    expect(ready).toContain('http://localhost:3000');
    expect(draw(service({ status: 'exited', exitCode: 1, endedAt: 1400 }))).toContain('exited');
    expect(draw(service({ status: 'stopped', endedAt: 1400 }))).toContain('stopped');
  });

  it('AC-25: NO braille frame appears on a service card, in any state', () => {
    // Stricter than `single-spinner-while-running` D-1 on purpose (D-14): a
    // service can sit at `starting` while the agent is IDLE, where D-1's "one
    // owner on screen" argument does not reach because there is no owner. A card
    // that animated only when the agent happened to be idle would be the worst
    // of both.
    for (const status of ['starting', 'ready', 'running', 'exited', 'stopped'] as const) {
      const frame = draw(service({ status }));
      expect(frame, status).not.toMatch(/[⠀-⣿]/);
    }
  });

  it('the terminal record is ONE row and names what happened', () => {
    const frame = draw(service({ terminal: true, status: 'stopped', endedAt: 1400, rows: [] }));
    expect(frame).toContain('service s1');
    expect(frame).toContain('stopped');
    expect(frame).not.toContain('npm run dev');
  });
});

describe('the reducer (D-11)', () => {
  it('serviceStart appends a card; serviceUpdate rewrites it in place', () => {
    let state = viewReducer(initialViewState(), { type: 'serviceStart', service: snapshot() });
    expect(state.entries).toHaveLength(1);
    state = viewReducer(state, {
      type: 'serviceUpdate',
      service: snapshot({ status: 'ready', url: 'http://localhost:3000', rowsSeen: 4 }),
    });
    expect(state.entries).toHaveLength(1);
    const entry = state.entries[0] as Extract<Entry, { kind: 'service' }>;
    expect(entry.status).toBe('ready');
    expect(entry.url).toBe('http://localhost:3000');
  });

  it('serviceEnd APPENDS a new one-row entry rather than only rewriting', () => {
    // `<Static>` cannot un-print, so any design that rewrites a printed card is
    // wrong whatever it claims (R-13). A second event at a second time is also
    // simply more honest.
    let state = viewReducer(initialViewState(), { type: 'serviceStart', service: snapshot() });
    state = viewReducer(state, {
      type: 'serviceEnd',
      service: snapshot({ status: 'exited', exitCode: 1, endedAt: 5000 }),
    });
    expect(state.entries).toHaveLength(2);
    const [card, record] = state.entries as Array<Extract<Entry, { kind: 'service' }>>;
    expect(card.terminal).toBeUndefined();
    expect(card.status).toBe('exited');
    expect(record.terminal).toBe(true);
  });

  it('a later update never rewrites the terminal record', () => {
    let state = viewReducer(initialViewState(), { type: 'serviceStart', service: snapshot() });
    state = viewReducer(state, { type: 'serviceEnd', service: snapshot({ status: 'stopped' }) });
    const before = state.entries;
    state = viewReducer(state, { type: 'serviceUpdate', service: snapshot({ status: 'ready' }) });
    // The live card was already settled by `serviceEnd`, and the record is
    // skipped by construction, so nothing moves.
    expect(state.entries[1]).toBe(before[1]);
  });
});

describe('AC-R7: session round-trip', () => {
  it('a restored non-terminal card is rewritten to `stopped`', () => {
    // The process died with the session - nothing here outlives the CLI by
    // design. And `starting` is the one that actually costs: it is the single
    // status that blocks the MONOTONIC settled boundary, so a restored one would
    // never settle and every frame for the rest of the session would re-render
    // the whole tail.
    const loaded = normalizeLoadedEntries([
      service({ status: 'starting', rows: ['x'], rowsSeen: 1 }),
    ]) as Array<Extract<Entry, { kind: 'service' }>>;
    expect(loaded[0]!.status).toBe('stopped');
    expect(loaded[0]!.rows).toEqual([]);
  });

  it('a restored TERMINAL record is left alone', () => {
    const loaded = normalizeLoadedEntries([
      service({ status: 'exited', exitCode: 1, terminal: true, rows: [] }),
    ]) as Array<Extract<Entry, { kind: 'service' }>>;
    expect(loaded[0]!.status).toBe('exited');
    expect(loaded[0]!.exitCode).toBe(1);
  });
});
