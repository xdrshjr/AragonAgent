import { describe, expect, it } from 'vitest';
import { createFileChangeStore, FILE_CHANGE_STORE_CAP } from '../tools/file-change-store.js';
import type { FilePatch } from '../tools/patch.js';

function patch(path: string): FilePatch {
  return {
    path,
    kind: 'update',
    added: 1,
    removed: 0,
    hunks: [],
    truncated: false,
    lineCount: 0,
  };
}

describe('FileChangeStore (agent-activity-presentation §3.3.5)', () => {
  it('takes once: the second read is undefined', () => {
    // Removal on read is what keeps a long session's store at constant size,
    // however many files are edited. `toolExecEnd` fires exactly once per call.
    const store = createFileChangeStore();
    store.record('lead', 't1', patch('a.ts'));
    expect(store.take('lead', 't1')?.path).toBe('a.ts');
    expect(store.take('lead', 't1')).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('evicts the oldest entry past the cap, so nothing accumulates (R-5)', () => {
    const store = createFileChangeStore();
    for (let i = 0; i < FILE_CHANGE_STORE_CAP + 1; i += 1) {
      store.record('lead', `t${i}`, patch(`${i}.ts`));
    }
    expect(store.size()).toBe(FILE_CHANGE_STORE_CAP);
    expect(store.take('lead', 't0')).toBeUndefined();
    expect(store.take('lead', `t${FILE_CHANGE_STORE_CAP}`)?.path).toBe(
      `${FILE_CHANGE_STORE_CAP}.ts`,
    );
  });

  it('does not let the same tool-call id collide across owners (D-13)', () => {
    // The segment is not fixing a live hazard — subagents get no recorder this
    // round — it is what makes the NEXT round's decision cheap.
    const store = createFileChangeStore();
    store.record('lead', 't1', patch('lead.ts'));
    store.record('child:1', 't1', patch('child.ts'));
    expect(store.take('lead', 't1')?.path).toBe('lead.ts');
    expect(store.take('child:1', 't1')?.path).toBe('child.ts');
  });

  it('re-recording the same key refreshes its age rather than keeping the old slot', () => {
    const store = createFileChangeStore(2);
    store.record('lead', 'a', patch('a.ts'));
    store.record('lead', 'b', patch('b.ts'));
    store.record('lead', 'a', patch('a2.ts'));
    store.record('lead', 'c', patch('c.ts'));
    expect(store.take('lead', 'b')).toBeUndefined();
    expect(store.take('lead', 'a')?.path).toBe('a2.ts');
    expect(store.take('lead', 'c')?.path).toBe('c.ts');
  });
});
