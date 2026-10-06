/**
 * Viewport virtualisation maths (tui-render-performance L3 / R1). Pure,
 * React-free, unit-tested.
 *
 * THE STRUCTURAL FIX. Ink's `renderNodeToOutput` has no early-out for clipped
 * subtrees: for every `ink-text` node it runs `squashTextNodes`, `widestLine`
 * and possibly `wrapText` — all O(chars) — and `Output.get()` then evaluates
 * `widestLine` a SECOND time before it is allowed to skip an out-of-clip
 * operation. A clipped 50 000-character entry therefore costs two full string
 * scans per frame and buys nothing. Bounding the ENTRY COUNT (`transcriptWindow`)
 * never bounded that, because one entry can be fifty thousand lines.
 *
 * So entries outside the visible band are not mounted at all. They are replaced
 * by two spacer boxes whose heights come from a height cache, which makes the
 * per-frame cost O(visible rows) instead of O(characters ever produced).
 *
 * V-4 — `offset` counts rows FROM THE BOTTOM (`layout/scroll.ts:1-13`), and that
 * is what makes virtualisation safe here for free: a height correction on an
 * entry ABOVE the viewport changes the content height and therefore
 * `overflowLines`, while `offset` — and hence what the user is looking at — is
 * unchanged. No scroll-anchoring compensation pass is required. Do NOT
 * "simplify" `offset` to count from the top.
 *
 * V-4 AS AMENDED BY tui-selection-and-scroll-follow (§4.3.1a). There is now
 * exactly ONE compensation pass — `follow-state.ts`'s Rule A — and it is
 * deliberately restricted to rows appended AT THE TAIL, published by
 * `Transcript.tsx` from the height table below. Everything the paragraph above
 * describes still self-compensates and is still not compensated for again.
 * The restriction is the whole of V-4's survival: an offset that reacted to
 * TOTAL measured height would turn every above-the-viewport correction into a
 * jump, would read a horizon front-drop as new output — and, because
 * `selectWindow` takes `offset` as an INPUT, would close a loop from the offset
 * through the mounted set and the measured heights back to the offset.
 */

import type { Entry } from '../../agent/reducer.js';
import type { DensityMode } from '../density.js';
import { FAST_LIMITS } from '../../fast/limits.js';
import { COMPACTION_LIMITS } from '../../compaction/limits.js';
import { GUTTER_WIDTH } from './Gutter.js';
import { USER_ENTRY_MAX_ROWS } from '../composer-limits.js';

export const VIRTUAL_LIMITS = {
  /**
   * Entries kept mounted on each side of the visible band.
   *
   * V-2 — must stay `>= 2`, so a one-row scroll can never expose an entry whose
   * height has never been measured at the very edge of the viewport.
   */
  overscan: 2,
  /** Height-cache ceiling (LRU). Four thousand numbers, not four thousand strings. */
  heightEntries: 4096,
} as const;

export type HeightKey = string;

/**
 * A cheap content version: it changes exactly when the rendered content does.
 *
 * DERIVED, NEVER HASHED. Hashing a 256 KiB string once per entry per frame would
 * recreate the very cost this module exists to remove, so every field below is
 * an O(1) read of a length or a scalar.
 *
 * I-L3-1 — this must change whenever the rendered output changes. The only lossy
 * case is a same-LENGTH text replacement, which the reducer cannot produce: all
 * text fields are append-only (`appendBounded` only ever elides the middle,
 * which changes the length). A future NON-APPEND mutation MUST extend the
 * revision, or the entry freezes at a stale height AND a stale rendered subtree
 * with nothing anywhere reporting it. `virtual-window.test.ts` enumerates every
 * kind against every mutating action.
 */
export function entryRevision(entry: Entry): string {
  switch (entry.kind) {
    case 'user':
      return 'u';
    case 'notice':
      return 'n';
    // `thinkingMs` is O(1) and it CHANGES THE ROW: sealing the clock turns
    // `* thought` into `* thought for 12s`, and with thinking hidden that row is
    // the entry's whole rendered height.
    case 'assistant':
      return `a${entry.text.length}.${entry.thinking?.length ?? 0}.${entry.streaming ? 1 : 0}.${
        entry.aborted ? 1 : 0
      }.${entry.thinkingMs ?? -1}`;
    // `patch.lineCount` is PRECOMPUTED for exactly this term: summing
    // `hunks[].lines.length` per entry per frame is the cost the height cache
    // exists to remove, and I-L3-1 forbids hashing.
    // `liveSeq` IS A COUNTER AND NOT `live.length`, and that is precisely the
    // NON-APPEND mutation I-L3-1 above says must extend the revision: a
    // fixed-size tail evicting its oldest row while appending a new one of the
    // same width leaves the joined length unchanged, so a length term would go
    // on matching while the card's content changed under it.
    //
    // SIX TERMS NOW, the longest revision in this file (P2-12). Still O(1) per
    // entry per frame, which is the property I-L3-1 requires -- but the next
    // field makes it seven, and a term that is not O(1) would put the cost this
    // module exists to remove back on every frame.
    case 'tool':
      return `t${entry.status}.${entry.argsRaw.length}.${entry.preview?.length ?? 0}.${
        entry.durationMs ?? -1
      }.${entry.patch?.lineCount ?? -1}.${entry.liveSeq ?? -1}`;
    case 'team':
      return `m${entry.active ? 1 : 0}.${entry.runs.length}.${entry.runs
        .map((r) => r.phase[0])
        .join('')}.${entry.runs.reduce((acc, r) => acc + r.toolCalls, 0)}`;
    case 'todo':
      return `d${entry.live ? 1 : 0}.${entry.doneCount}.${entry.total}.${entry.items.length}`;
    /**
     * The retry card is ONE ROW IN EVERY PHASE, so its revision carries the phase
     * and the counter but deliberately NOT the countdown: `resumeAt` changes the
     * rendered SECONDS once a second while the height stays 1, and folding it in
     * here would invalidate the height cache 30 times per backoff to re-measure a
     * number that cannot change the answer.
     *
     * `phase` and `attempt` ARE in, because they change the row's text and a stale
     * measurement would be wrong in a way nothing reports (I-L3-1).
     */
    case 'retry':
      return `r${entry.phase}.${entry.attempt}.${entry.maxRetries}`;
    /**
     * `status`, `live` and the TEXT LENGTH, because all three change the rows the
     * card draws: `advice` renders a body, everything else renders one line, and
     * the body's length decides how many rows it wraps to. `durationMs` is in the
     * header, which is `wrap="truncate"`, so it can never change the height.
     */
    case 'fast':
      return `f${entry.status}.${entry.live ? 1 : 0}.${entry.text?.length ?? 0}.${
        entry.detail?.length ?? 0
      }`;
    /**
     * `live`, the SUMMARY LENGTH and `mode`, because all three change the rows the
     * card draws: a live card renders a headline and no body, a settled one
     * renders the summary (whose length decides how many rows it wraps to), and
     * `mode` selects between the "summarized N messages" and "dropped N WITHOUT a
     * summary" detail lines. `durationMs` is inside the `wrap="truncate"`
     * headline, so it can never change the height.
     */
    case 'compaction':
      return `c${entry.live ? 1 : 0}.${entry.summary?.length ?? 0}.${entry.mode}.${
        entry.applied ? 1 : 0
      }`;
    /**
     * `rowsSeen`, AND NEVER `rows.length` (background-service-supervision P0-3).
     *
     * The service tail is a FIXED-SIZE RING: it evicts its oldest row while
     * appending a new one, so the joined length is unchanged while the content is
     * not. That is verbatim the NON-APPEND mutation I-L3-1 above says must extend
     * the revision, and it is the same trap — and the same fix — as the `tool`
     * branch's `liveSeq` two cases up. A length term would go on matching while
     * the card changed underneath it, and the card would freeze at a stale height
     * AND a stale rendered subtree with nothing anywhere reporting it.
     *
     * `status` and the presence of a URL are in because both change the rows the
     * card draws; `exitCode` is in because the terminal row names it.
     */
    case 'service':
      return `v${entry.status}.${entry.rowsSeen}.${entry.url ? 1 : 0}.${entry.exitCode ?? -1}.${
        entry.terminal ? 1 : 0
      }`;
    default:
      return 'x';
  }
}

/**
 * The height-cache key.
 *
 * V-5 — `cols` is part of the key, so a resize invalidates every entry. The
 * frame after a resize renders from estimates and re-measures lazily: one
 * reflow, no crash, no stale layout.
 *
 * `flags` carries the render-affecting switches that are neither per-entry nor
 * part of `density` — today only `thinkingVisible` (Ctrl+T). It is a parameter
 * rather than a fifth positional scalar so a future switch costs one character
 * at the call site instead of a signature change at four.
 */
export function heightKey(
  entry: Entry,
  cols: number,
  expanded: boolean,
  density: DensityMode,
  flags = '',
): HeightKey {
  return `${entry.id}|${entryRevision(entry)}|${cols}|${expanded ? 1 : 0}|${density}|${flags}`;
}

/** Rows a string occupies at `usable` columns, wrapping included. At least 1. */
function wrappedRows(text: string, usable: number): number {
  const width = Math.max(1, usable);
  let rows = 0;
  let lineLen = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      rows += Math.max(1, Math.ceil(lineLen / width));
      lineLen = 0;
    } else {
      lineLen += 1;
    }
  }
  return rows + Math.max(1, Math.ceil(lineLen / width));
}

/** Collapsed preview rows in `ToolCard`; duplicated as a NUMBER, not imported. */
const TOOL_COLLAPSED_LINES = 8;
/** Collapsed diff rows in `DiffView`; duplicated for the same reason as above. */
const DIFF_COLLAPSED_LINES = 12;
/** Live tail rows in `ToolCard`; duplicated as a NUMBER, for the same reason. */
const TOOL_LIVE_TAIL_ROWS = 8;
/** Tail rows a COLLAPSED `ServiceCard` draws; duplicated for the same reason. */
const SERVICE_COLLAPSED_TAIL_ROWS = 2;
/** Tail rows an EXPANDED `ServiceCard` draws; the snapshot cap (8). */
const SERVICE_EXPANDED_TAIL_ROWS = 8;

/**
 * Pure UPPER-BOUND estimate of an entry's height, used until a real measurement
 * exists.
 *
 * Upper bound rather than best guess, and deliberately so: an over-estimate
 * makes the scroll position slightly conservative and self-corrects the frame
 * after the entry is measured, while an under-estimate can put the newest output
 * off the bottom of a viewport the user believes is pinned.
 */
export function estimateEntryRows(
  entry: Entry,
  cols: number,
  density: DensityMode,
  expanded: boolean,
  thinkingVisible = true,
): number {
  const usable = Math.max(1, cols - GUTTER_WIDTH);
  // `separationRows` needs the PRECEDING entry, which a per-entry estimate does
  // not have. One row is its maximum, so charging it unconditionally keeps this
  // an upper bound (`compact` never spends it at all).
  const separation = density === 'comfortable' ? 1 : 0;

  switch (entry.kind) {
    case 'user':
      // MIRRORS `UserEntry`'s RENDER CAP (+1 for the `... +N more lines` tail).
      // THESE TWO NUMBERS ARE ONE NUMBER (I-13). Capping the renderer alone
      // would leave this function believing a 5 000-line message is 5 000 rows
      // tall -- and unlike an ordinary over-estimate that failure does NOT
      // self-correct: this file's own note above records that "an entry
      // estimated at 400 rows is exactly the one that never gets mounted", and
      // an unmounted entry is never measured.
      return (
        separation + Math.min(wrappedRows(entry.text, usable), USER_ENTRY_MAX_ROWS + 1)
      );
    case 'notice':
      return separation + wrappedRows(entry.text, usable);
    case 'assistant': {
      // THE PARAMETER'S `true` DEFAULT IS A FAIL-SAFE FOR A FORGOTTEN CALLER,
      // NOT THE PLAN FOR THE ONE THERE IS (P1-6a). `Transcript.tsx` holds
      // `thinkingVisible` as a prop and MUST pass it: with thinking hidden by
      // default, an unpassed flag inflates every assistant entry that thought by
      // `1 + wrappedRows(thinking)` — hundreds of rows at `thinkingLevel: high`
      // against a real height of one. The self-correction argument does not
      // rescue that, because an entry is only measured once `selectWindow`
      // mounts it, and an entry estimated at 400 rows is exactly the one that
      // never gets mounted.
      const thinking = !entry.thinking
        ? 0
        : thinkingVisible
        ? 1 + wrappedRows(entry.thinking, usable)
        : // The collapsed `thought for Ns` marker is exactly one row, and it is
          // suppressed while the entry is still streaming (the activity line is
          // the live surface then).
          entry.streaming
        ? 0
        : 1;
      const body = entry.text.length > 0 ? wrappedRows(entry.text, usable) : 1;
      return separation + thinking + body + (entry.aborted ? 1 : 0);
    }
    case 'tool': {
      const settled = entry.status === 'done' || entry.status === 'error';
      // WHEN A PATCH IS PRESENT IT, NOT THE PREVIEW, IS WHAT DRAWS (§3.4): the
      // stored preview is one line by then, so estimating from it would report a
      // 3-row card for a 12-row diff — an UNDER-estimate, the direction this
      // file names as unsafe.
      if (settled && entry.patch) {
        const rows = entry.patch.lineCount + Math.max(0, entry.patch.hunks.length - 1);
        const shown = expanded ? rows : Math.min(rows, DIFF_COLLAPSED_LINES);
        // card header + `+N -M` summary + rows + footer
        return separation + 1 + 1 + shown + 1;
      }
      // THE ONE-LINE `if (!entry.preview || !settled)` THIS REPLACES COVERED TWO
      // CASES, and both must survive the split (P1-4): not settled, and settled
      // with nothing to draw (an aborted call, a tool that returned an empty
      // string). A `!settled` block alone would drop the second into
      // `wrappedRows(entry.preview, usable)` with `undefined`.
      if (!settled) {
        const live = entry.live?.length ?? 0;
        if (live === 0) return separation + 1;
        // Header + tail rows + the unconditional stall/`(running)` footer row.
        //
        // ROWS ARE COUNTED, NOT WRAPPED, which is legitimate only because every
        // live row is rendered `wrap="truncate"` AND clipped at
        // `LIVE_ROW_MAX_CHARS` on the way into the store -- the same argument
        // `DiffView.tsx:6-11` makes for itself, and the same coupling: if a
        // future change lets a live row wrap, this silently UNDER-counts, the
        // direction this file names as the one the layout cannot absorb.
        return separation + 1 + Math.min(live, TOOL_LIVE_TAIL_ROWS) + 1;
      }
      if (!entry.preview) {
        return separation + 1;
      }
      const lines = wrappedRows(entry.preview, usable);
      const shown = expanded ? lines : Math.min(lines, TOOL_COLLAPSED_LINES);
      // header + body + the `+N lines (Ctrl+O)` / `(Ctrl+O to collapse)` footer
      return separation + 1 + shown + 1;
    }
    case 'team':
      return separation + 1 + entry.runs.length + (expanded ? entry.runs.length * 3 + 1 : 1);
    case 'todo':
      return separation + 1 + entry.items.length;
    // ONE ROW, ALWAYS. The card is `wrap="truncate"` in every phase, so this is an
    // exact height rather than an upper bound.
    case 'retry':
      return separation + 1;
    // ADDING THE CASE TO ONLY ONE OF THIS FILE'S TWO SWITCHES YIELDS A
    // TRANSCRIPT WHOSE SCROLL ARITHMETIC DISAGREES WITH WHAT IT DREW, which
    // manifests as drift rather than as an error (RV-13). Header row, then
    // either the wrapped critique (clamped to `cardTextRows`) or one status
    // line — an upper bound, which is what this function owes its caller.
    case 'fast': {
      const body =
        entry.status === 'advice' && entry.text
          ? Math.min(FAST_LIMITS.cardTextRows, wrappedRows(entry.text, usable))
          : 1;
      return separation + 1 + body;
    }
    // THE SECOND SWITCH, and adding the case to only one of the two yields a
    // transcript whose scroll arithmetic disagrees with what it drew — drift
    // rather than an error (C-9 / RV-13). Headline row, one detail row, then the
    // summary clamped to `cardTextRows` (or unclamped when expanded) plus the
    // `+N more lines` footer. An UPPER BOUND, which is what this function owes
    // its caller.
    case 'compaction': {
      const lines = entry.summary ? wrappedRows(entry.summary, usable) : 0;
      const body = expanded ? lines : Math.min(lines, COMPACTION_LIMITS.cardTextRows);
      const footer = lines > body || (expanded && lines > COMPACTION_LIMITS.cardTextRows) ? 1 : 0;
      return separation + 1 + 1 + body + footer;
    }
    /**
     * THE THIRD SWITCH, and adding the case to only one of this file's two
     * yields a transcript whose scroll arithmetic disagrees with what it drew —
     * drift rather than an error (P0-3 / RV-13). Both `default` branches swallow
     * an unknown kind silently, and `virtual-window.test.ts` hand-enumerates
     * kinds, so neither omission turns anything red on its own.
     *
     * A terminal record is exactly one row. A live card is the status row, the
     * URL row when there is one, and the tail — counted, not wrapped, which is
     * legitimate only because every row is `wrap="truncate"` AND clipped at
     * `LIVE_ROW_MAX_CHARS` on the way into the ring, the same coupling the
     * `tool` branch above records for itself.
     */
    case 'service': {
      if (entry.terminal) return separation + 1;
      const url = entry.url ? 1 : 0;
      const tail = expanded
        ? Math.min(entry.rows.length, SERVICE_EXPANDED_TAIL_ROWS)
        : Math.min(entry.rows.length, SERVICE_COLLAPSED_TAIL_ROWS);
      return separation + 1 + url + tail;
    }
    default:
      return separation + 1;
  }
}

export interface WindowSelection {
  /** First mounted entry, inclusive. */
  startIndex: number;
  /** One past the last mounted entry. */
  endIndex: number;
  /** Spacer rows above the mounted slice. */
  leadingRows: number;
  /** Spacer rows below the mounted slice. */
  trailingRows: number;
  /** Sum of every entry height, measured or estimated. */
  totalRows: number;
}

export interface SelectWindowInput {
  trailingContentRows?: number;
  entries: readonly Entry[];
  /** Measured, else estimated; never 0 for a real entry. */
  heightOf: (index: number) => number;
  viewportRows: number;
  /** Rows hidden BELOW the viewport — the existing `scroll.ts` semantic (V-4). */
  offset: number;
  /** `>= 2` (V-2). Lower values are raised rather than honoured. */
  overscan: number;
}

/** Choose which entries to mount, and how tall the two spacers must be. */
export function selectWindow(input: SelectWindowInput): WindowSelection {
  const { entries, heightOf } = input;
  const n = entries.length;
  if (n === 0) {
    return { startIndex: 0, endIndex: 0, leadingRows: 0, trailingRows: 0, totalRows: 0 };
  }

  const heights: number[] = new Array(n);
  let totalRows = 0;
  for (let i = 0; i < n; i += 1) {
    const h = heightOf(i);
    const rows = Number.isFinite(h) && h > 0 ? Math.floor(h) : 1;
    heights[i] = rows;
    totalRows += rows;
  }

  // A viewport of 0 is the FIRST FRAME, before `measureElement` has run. Falling
  // back to 1 keeps the live tail mounted through it, so the first paint is real
  // content rather than a blank rectangle that only fills in on the second.
  const viewport = Math.max(1, Math.floor(input.viewportRows) || 0);
  const offset = Math.max(0, Math.floor(input.offset) || 0);
  const overscan = Math.max(VIRTUAL_LIMITS.overscan, Math.floor(input.overscan) || 0);

  const bottom = totalRows + (input.trailingContentRows ?? 0) - offset;
  const top = bottom - viewport;

  let start = n - 1;
  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    const next = acc + heights[i]!;
    if (next > top) {
      start = i;
      break;
    }
    acc = next;
  }

  let end = n;
  acc = 0;
  for (let i = 0; i < n; i += 1) {
    if (acc >= bottom) {
      end = i;
      break;
    }
    acc += heights[i]!;
  }

  start = Math.max(0, start - overscan);
  end = Math.min(n, end + overscan);

  // V-3 — while pinned, the LAST entry is always inside the window, whatever its
  // height. The live tail must be real content and never a spacer, or a
  // streaming answer renders as a growing blank rectangle.
  if (offset <= 0) end = n;
  if (end <= start) end = Math.min(n, start + 1);

  let leadingRows = 0;
  for (let i = 0; i < start; i += 1) leadingRows += heights[i]!;
  let trailingRows = 0;
  for (let i = end; i < n; i += 1) trailingRows += heights[i]!;

  return { startIndex: start, endIndex: end, leadingRows, trailingRows, totalRows };
}
