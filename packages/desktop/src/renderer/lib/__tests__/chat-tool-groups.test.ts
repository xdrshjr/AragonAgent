import { describe, expect, it } from 'vitest';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import {
  MIN_GROUP_SIZE, groupOfEntry, groupToolRuns, isToolGroup, rowIndexOfEntry, type GroupOptions, type ToolGroupRow,
} from '../chat-tool-groups.js';

let counter = 0;
const tool = (name: string, over: Partial<Extract<Entry, { kind: 'tool' }>> = {}): Entry => {
  counter += 1;
  return {
    id: `t${counter}`, kind: 'tool', toolCallId: `c${counter}`, name, label: name, argsRaw: '{}', status: 'done', ...over,
  } as Entry;
};
const read = (): Entry => tool('read_file');
const grep = (): Entry => tool('grep');
const list = (): Entry => tool('list_dir');
const assistant = (): Entry => ({ id: `a${++counter}`, kind: 'assistant', text: 'hm', streaming: false } as unknown as Entry);

const ON: GroupOptions = { enabled: true, voiceMode: 'friendly', expanded: new Set() };
const groups = (rows: readonly unknown[]): ToolGroupRow[] => (rows as Array<{ kind: string }>).filter((row) => row.kind === 'toolGroup') as ToolGroupRow[];

describe('groupToolRuns (AC-G1..G3)', () => {
  it('folds five finished reads into one group that remembers every member', () => {
    const entries = [read(), read(), read(), read(), read()];
    const rows = groupToolRuns(entries, ON);
    expect(rows).toHaveLength(1);
    const group = rows[0] as ToolGroupRow;
    expect(isToolGroup(group)).toBe(true);
    expect(group.entryIds).toEqual(entries.map((entry) => entry.id));
    expect(group.counts).toEqual({ read: 5, search: 0, list: 0 });
    expect(group.id).toBe(entries[0]!.id);
  });

  it('counts each family and treats glob as a search', () => {
    const rows = groupToolRuns([read(), grep(), tool('glob'), list(), read()], ON);
    expect((rows[0] as ToolGroupRow).counts).toEqual({ read: 2, search: 2, list: 1 });
  });

  it('needs at least three: two reads stay as cards', () => {
    expect(MIN_GROUP_SIZE).toBe(3);
    const entries = [read(), read()];
    expect(groupToolRuns(entries, ON)).toEqual(entries);
  });

  it('2 reads + an edit + 3 reads folds only the last three; the edit interrupts (AC-G2)', () => {
    const [r1, r2, edit, r3, r4, r5] = [read(), read(), tool('edit_file'), read(), read(), read()];
    const rows = groupToolRuns([r1!, r2!, edit!, r3!, r4!, r5!], ON);
    expect(rows.map((row) => row.kind)).toEqual(['tool', 'tool', 'tool', 'toolGroup']);
    expect((rows[3] as ToolGroupRow).entryIds).toEqual([r3!.id, r4!.id, r5!.id]);
  });

  it('never folds a failed, running or pending call, and leaves it where it was (AC-G3)', () => {
    const failed = tool('read_file', { status: 'error', isError: true });
    const failedDone = tool('read_file', { status: 'done', isError: true });
    const running = tool('read_file', { status: 'running' });
    const pending = tool('grep', { status: 'pending' });
    for (const odd of [failed, failedDone, running, pending]) {
      const rows = groupToolRuns([read(), read(), read(), odd, read()], ON);
      expect(rows.map((row) => row.kind), odd.id).toEqual(['toolGroup', 'tool', 'tool']);
      expect(rows[1]).toBe(odd);
    }
  });

  it('never folds writes, commands or anything outside the three families', () => {
    for (const name of ['edit_file', 'write_file', 'bash', 'job_wait', 'mcp__x__y']) {
      const entries = [tool(name), tool(name), tool(name), tool(name)];
      expect(groupToolRuns(entries, ON)).toEqual(entries);
    }
  });

  it('ends a run at ANY other entry kind, not just a tool (RV-8)', () => {
    const others: Entry[] = [
      assistant(),
      { id: 'n', kind: 'notice', level: 'info', text: 'x' },
      { id: 'u', kind: 'user', text: 'hi' },
      { id: 'q', kind: 'queued', text: 'hi' },
      { id: 'tt', kind: 'todo' },
      { id: 'tm', kind: 'team' },
      { id: 'f', kind: 'fast' },
      { id: 'r', kind: 'retry' },
      { id: 'c', kind: 'compaction' },
      { id: 'g', kind: 'governance' },
      { id: 's', kind: 'service' },
    ] as unknown as Entry[];
    for (const interrupter of others) {
      const rows = groupToolRuns([read(), read(), interrupter, read(), read()], ON);
      expect(groups(rows), interrupter.kind).toHaveLength(0);
    }
  });

  it('keeps the group id when the run grows at its tail, so its measured height and open state stay', () => {
    const first = [read(), read(), read()];
    const before = groupToolRuns(first, ON)[0] as ToolGroupRow;
    const after = groupToolRuns([...first, read()], ON)[0] as ToolGroupRow;
    expect(after.id).toBe(before.id);
    expect(after.entryIds).toHaveLength(4);
  });

  it('reflects which groups were opened', () => {
    const entries = [read(), read(), read()];
    const open = groupToolRuns(entries, { ...ON, expanded: new Set([entries[0]!.id]) })[0] as ToolGroupRow;
    expect(open.expanded).toBe(true);
    expect((groupToolRuns(entries, ON)[0] as ToolGroupRow).expanded).toBe(false);
  });
});

describe('the kill switch and developer mode (AC-G4)', () => {
  const entries = [read(), read(), read(), read()];
  it('returns the SAME array when disabled', () => {
    expect(groupToolRuns(entries, { ...ON, enabled: false })).toBe(entries);
  });
  it('returns the SAME array in developer mode', () => {
    expect(groupToolRuns(entries, { ...ON, voiceMode: 'developer' })).toBe(entries);
  });
});

describe('rowIndexOfEntry (RV-9, AC-G5)', () => {
  it('maps a folded member to the group row, and a plain entry to its own row', () => {
    const lead = assistant();
    const members = [read(), read(), read()];
    const tail = assistant();
    const rows = groupToolRuns([lead, ...members, tail], ON);
    expect(rowIndexOfEntry(rows, lead.id)).toBe(0);
    for (const member of members) expect(rowIndexOfEntry(rows, member.id)).toBe(1);
    expect(rowIndexOfEntry(rows, tail.id)).toBe(2);
    expect(rowIndexOfEntry(rows, 'missing')).toBe(-1);
  });

  it('finds the group a member is folded into', () => {
    const members = [read(), read(), read()];
    const rows = groupToolRuns(members, ON);
    expect(groupOfEntry(rows, members[2]!.id)?.id).toBe(members[0]!.id);
    expect(groupOfEntry(rows, 'missing')).toBeNull();
  });

  it('is the identity when nothing is folded', () => {
    const entries = [assistant(), read(), assistant()];
    const rows = groupToolRuns(entries, ON);
    entries.forEach((entry, index) => expect(rowIndexOfEntry(rows, entry.id)).toBe(index));
  });
});

describe('cost (AC-G8)', () => {
  // The MINIMUM of several runs: it is the cost with the least outside interference (a collection pause or
  // a busy neighbour only ever adds time), which is what a complexity comparison needs.
  const fastest = (values: number[]): number => Math.min(...values);
  const build = (n: number): Entry[] => Array.from({ length: n }, (_unused, index) => (index % 7 === 6 ? assistant() : read()));
  const time = (entries: Entry[]): number => {
    const samples: number[] = [];
    for (let run = 0; run < 11; run += 1) {
      const start = performance.now();
      groupToolRuns(entries, ON);
      samples.push(performance.now() - start);
    }
    return fastest(samples);
  };

  it('grows roughly linearly: 10x the entries takes far less than quadratic time', () => {
    // Sizes chosen so a run costs milliseconds, not microseconds: at 1k entries the timer's own noise
    // and one garbage collection are bigger than the work, and the ratio flaps. A quadratic version
    // would show ~100x here, so the bound still separates the two cleanly.
    const small = build(20_000);
    const large = build(200_000);
    time(small); time(large); // warm up
    const ratio = time(large) / Math.max(time(small), 0.01);
    // Linear is ~10x; quadratic is ~100x. 40 leaves room for a collection pause on a loaded machine.
    expect(ratio).toBeLessThan(40);
  });
});
