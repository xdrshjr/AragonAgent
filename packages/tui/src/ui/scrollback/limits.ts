/**
 * Structural limits of native-scroll mode (tui-native-terminal-scroll §4.3-§4.6).
 *
 * Structural caps live here; tunable policy lives in `config/schema.ts`. None of
 * these is a user preference: each one bounds a failure (a runaway write, a live
 * region that eats the screen) rather than expressing a taste.
 */

export const SCROLLBACK_LIMITS = {
  /** Pending static entries the drain holds before folding the oldest into a marker. */
  feedCapacity: 32,
  /** Rows one entry may print; the rest is replaced by one ASCII notice row. */
  maxRowsPerEntry: 400,
  /** Static rows per `stdout.write`; larger feeds are split into consecutive batches. */
  maxRowsPerBatch: 2000,
  /** tall-frame swallows within this window after a resize are expected and uncounted. */
  guardResizeGraceMs: 250,
  /** Consecutive out-of-resize tall frames that degrade the app to the placeholder. */
  guardTripCount: 3,
  /** Session summary rows printed on exit. */
  exitSummaryMaxRows: 4,
  /**
   * Entries the region may hold on screen at once
   * (tui-full-height-live-region D6; the WINDOW is defined by I-F8 and computed in
   * `tail-window.ts`).
   *
   * 10 is DERIVED, not a preference. The band's left column is the whole pool
   * (`pool = rows - 1 - header - composer - status`, i.e. 24 rows on a 30-row
   * terminal) and one entry occupies about 2.4 rows, so a window of 4 would leave
   * the column half empty - the blank band this feature removes. It stays in the
   * per-frame COST class the old value of 4 was measured in: `EntryView` is
   * memoised and only the streaming entry re-renders, so this bounds component
   * instances, not per-frame work.
   *
   * There is deliberately NO companion row cap any more (retired: the old
   * `maxLiveTailRows` / `liveTailRowShare` pair). The rows a tail may take are
   * `band.previewRows` - the whole left column - and "the region can never be
   * taller than the screen" is `liveRows === rows - 1`'s job (I-F5), not a second
   * number's. Those two caps disagreed with the pool, and that disagreement WAS the
   * blank band between the result and the running card.
   */
  liveTailMaxEntries: 10,
  /**
   * Safety margin the live tail asks for before it anchors its content to the TOP of
   * the region (tui-first-reply-bottom-aligned, plan A-prime; the decision itself is
   * `tail-anchor.ts`).
   *
   * 2 is DERIVED, not a preference. The anchor is decided from
   * `layout/virtual-window.ts::estimateEntryRows`, which charges one separation row per
   * entry and counts RAW markdown lines - so it UNDER-estimates a `#` heading (which
   * also draws an `hrule`) and a code block (whose rail narrows the text by two columns,
   * making long lines wrap). Inside a virtual window that error self-corrects when the
   * entry is measured; the live region has no measurement pass, so the same error would
   * decide which rows get CLIPPED - and `flex-start` clips the NEWEST rows.
   * The margin must therefore always stay on the `bottom` side: a needless fallback
   * costs one stacked frame, an early anchor hides the text the user is waiting for.
   */
  tailAnchorSlackRows: 2,
  /**
   * Rows the rail needs before the band will show it: `TODO_LIMITS.panelMinRows + 1`.
   *
   * The `+ 1` is not decoration - the rail takes its rows from the same pool as one
   * preview row, and a band that seats the rail but no preview loses the streaming
   * answer entirely (band.ts step 3 / AC-12).
   */
  railBandMinRows: 4,
  /**
   * How long the cursor-position probe waits for `ESC[<row>;<col>R`.
   *
   * A STRUCTURAL CAP, not a preference (tui-bottom-anchored-live-region §4.4): it
   * bounds "how much startup latency a terminal that does not answer may cost". The
   * round trip is under 5 ms locally and under 60 ms over SSH, so 150 ms is
   * generous, and the probe runs once per session — never per frame, never per
   * keystroke. Anything longer and a terminal without CPR support would pay it on
   * every launch.
   */
  anchorProbeTimeoutMs: 150,
  /**
   * Settle window before re-measuring the cursor after a resize.
   *
   * A STRUCTURAL CAP for the same reason: a drag fires dozens of resize events, and
   * one CPR per event would both flood the input channel and make the region jitter.
   * 200 ms is below the point a user perceives as "the input box is stuck".
   */
  anchorReprobeDelayMs: 200,
  /**
   * Structural ceiling on the height of a STARTING canvas.
   *
   * It bounds the bytes a batch may write and the rows the content cache may hold on
   * an extreme terminal (`rows` 3000). Two limits on how it may be applied, both
   * arithmetic rather than taste:
   *  - the rows a canvas leaves unused do not disappear, they stay above it as the
   *    permanent region, so a smaller starting canvas never loses content;
   *  - it must NEVER clip a live canvas. A canvas that has overflowed and scrolled
   *    grows to `rows - 1`, and shrinking one back would make the next erase reach
   *    above its own top: host output erased, every visible row printed twice.
   */
  maxCanvasRows: 200,
} as const;
