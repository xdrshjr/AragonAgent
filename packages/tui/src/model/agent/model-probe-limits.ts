/**
 * Structural bounds for the profile connection probe (model-profile-connection-test §7).
 *
 * STRUCTURAL, NOT POLICY: nothing here is clamped, persisted or user-tunable. These
 * are the physical limits of one probe - how long a single round trip may take, how
 * many lines and characters a result may occupy, how many models a list page can
 * carry before it must truncate. The user-tunable keys live in `config/schema.ts`.
 *
 * THE OUTPUT-TOKEN CAP IS DELIBERATELY ABSENT. It must come from core's
 * `MIN_MAX_OUTPUT_TOKENS`, or this file becomes a second authority for "how many
 * tokens may this model produce" - which is exactly what `output-limits.ts` exists
 * to prevent.
 *
 * ASCII ONLY: this module lives in `agent/`, which `glyphs.test.ts::inScope` scans.
 */

export interface ProbeLimits {
  /** Ceiling on ONE real round trip (`complete`). */
  testTimeoutMs: number;
  /**
   * Sub-budget for the best-effort model list that runs CONCURRENTLY with the
   * completion. It never decides the verdict (§4.3 / RV-P1-1): a slow `/models`
   * that ate the adapter's own 15 s discovery timeout would turn a healthy
   * connection into a false `timeout`.
   */
  listModelsBudgetMs: number;
  /** Ceiling on a discovery (`listModels`) issued from the list page. */
  discoveryTimeoutMs: number;
  /** Characters of the model's reply kept for the `Reply:` line. */
  replyChars: number;
  /** Characters of a locally composed failure sentence. */
  detailChars: number;
  /** Rows a list page may carry before `truncated` becomes true. */
  maxListedModels: number;
  /** Above this many rows the list page grows a search line (picker parity). */
  searchThreshold: number;
  /** Characters of a model's display name kept in one list row. */
  maxNameChars: number;
}

export const PROBE_LIMITS: ProbeLimits = {
  testTimeoutMs: 20_000,
  listModelsBudgetMs: 5_000,
  discoveryTimeoutMs: 20_000,
  replyChars: 60,
  detailChars: 160,
  maxListedModels: 400,
  searchThreshold: 8,
  maxNameChars: 48,
};
