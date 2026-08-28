/**
 * The CLI-local side channel a `FilePatch` travels on (agent-activity-presentation
 * §3.3.5 / D-8).
 *
 * The patch does NOT ride in the tool result: `ToolResult` has no metadata
 * channel and `packages/core`'s surface is frozen by `public-api.test.ts`, and
 * more importantly a richer display must not cost the model more tokens. So the
 * tool records the patch here, keyed by its own tool-call id, and `reduceEvent`
 * takes it out again when `tool_execution_end` arrives.
 *
 * Three properties, each load-bearing:
 *
 *  - **Owner-scoped.** The key is `${owner}:${toolCallId}`. Only `'lead'` is ever
 *    written this round (`team/**` is out of scope, so `buildSubagentTools`
 *    passes no recorder), but subagents build their tools from the same factory
 *    — so the day one gets a recorder, a child's tool-call id must not be able
 *    to land on a lead's card. One string concatenation, spent now (D-13).
 *  - **Take-once.** `tool_execution_end` fires exactly once per call, and a patch
 *    not consumed there never will be. Removal on read is what keeps a long
 *    session's store at constant size however many files are edited.
 *  - **Bounded FIFO.** At `cap` entries the oldest key is evicted. The cap is a
 *    RING, not a leak detector: nothing is retained longer than `cap` writes, so
 *    a patch nobody consumes cannot accumulate.
 */

import type { FilePatch } from './patch.js';

export interface FileChangeStore {
  record(owner: string, toolCallId: string, patch: FilePatch): void;
  /** Returns and REMOVES the patch. A patch is consumed exactly once. */
  take(owner: string, toolCallId: string): FilePatch | undefined;
  size(): number;
}

/** Entries retained before the oldest is evicted. */
export const FILE_CHANGE_STORE_CAP = 64;

export function createFileChangeStore(cap = FILE_CHANGE_STORE_CAP): FileChangeStore {
  // A `Map` iterates in insertion order, so the first key IS the oldest.
  const entries = new Map<string, FilePatch>();
  const limit = Math.max(1, Math.floor(cap));

  const keyOf = (owner: string, toolCallId: string): string => `${owner}:${toolCallId}`;

  return {
    record(owner, toolCallId, patch) {
      const key = keyOf(owner, toolCallId);
      // Delete first so a re-record moves the key to the END of the ring rather
      // than leaving it at its original age.
      entries.delete(key);
      entries.set(key, patch);
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    take(owner, toolCallId) {
      const key = keyOf(owner, toolCallId);
      const patch = entries.get(key);
      if (patch !== undefined) entries.delete(key);
      return patch;
    },
    size() {
      return entries.size;
    },
  };
}
