/**
 * TEAM_LIMITS — the single authority on every bound this subsystem enforces
 * (team-subagents §3.5 / §3.6).
 *
 * ASCII ONLY: `src/team/**` is inside the glyph scanner's scope
 * (`glyphs.test.ts`), so no literal in this tree may hold a non-ASCII byte.
 *
 * TWO KINDS OF NUMBER LIVE HERE AND THEY ARE NOT INTERCHANGEABLE.
 *
 *  - The `TEAM_LIMITS` entries below are STRUCTURAL: they describe what the
 *    report format, the message channel and the panel can physically carry, and
 *    a user has no business tuning them. They are constants.
 *  - The six `team.*` config keys (`config/schema.ts`) are POLICY: how wide to
 *    fan out, how long to wait. They are clamped, persisted and user-facing.
 *
 * `hardMaxSubagents` sits on the structural side ON PURPOSE even though it
 * bounds a config key: the requirement caps the fan-out at 10 (R-g), so a
 * hand-edited `config.json` must not be able to raise it. It is applied twice —
 * once in `clampTeamConfig` and once in `normalizeSubagentSpecs` — because a
 * clamp that only runs on the read path leaves a bad value on disk.
 *
 * BYTES, NOT CHARACTERS, for every report budget (D-8 / I-9). `ToolExecutor`
 * truncates combined tool text at 100 000 BYTES; a 24 000-character CJK report
 * is 72 000 bytes, so a character-denominated cap would let the executor chop
 * the report mid-section and take the failure count with it.
 */

/**
 * The two factors of the dispatch-total look budget (R-P1-6), hoisted only so
 * `TEAM_LIMITS.overseerMaxLooksPerDispatch` can state their product without a
 * second copy of either number. Not for export: the authority is TEAM_LIMITS.
 */
const HARD_MAX_SUBAGENTS = 10;
const OVERSEER_MAX_LOOKS_PER_CHILD = 12;

export const TEAM_LIMITS = {
  /**
   * The requirement's ceiling (R-g). Enforced in `clampTeamConfig` AND in
   * `normalizeSubagentSpecs`, so neither a hand-edited file nor a model asking
   * for thirty can exceed it.
   *
   * 10 IS THE CEILING, 8 IS THE DEFAULT (`DEFAULT_TEAM_CONFIG`): different
   * numbers on purpose (subagent-fanout D-1 / D-2). The default is a policy
   * choice the user may move in either direction from the settings screen; this
   * bound is what no user may move.
   */
  hardMaxSubagents: HARD_MAX_SUBAGENTS,

  // --- Spec normalization (§3.3.1) ---
  /** `SubagentSpec.description`, clamped (never rejected). */
  descriptionChars: 60,
  /** `SubagentSpec.prompt`, clamped. The child cannot see the conversation, so
   *  this has to be generous enough to carry a whole brief. */
  promptChars: 8000,
  /**
   * The brief `/subagent <brief>` copies into its forced-directive turn
   * (subagent-fanout 3.5.4 / R-10). CHARACTERS, not bytes, because this bound
   * feeds a user-visible truncation marker rather than a wire budget: past it
   * the directive says `[brief truncated]` so a clipped instruction is never
   * mistaken for a complete one.
   */
  forcedBriefChars: 4000,
  /**
   * Parts `/subagent --parts a,b,c` may name BEFORE `maxSubagents` narrows them
   * (subagent-fanout 3.5.2 rule 3). The second, smaller ceiling is the policy
   * number and belongs to the command body; this one only bounds what one
   * argument can carry.
   */
  forcedPartsMax: 8,
  /** Slugified `SubagentSpec.label`. Long enough to be meaningful in the panel,
   *  short enough that five of them fit one row of an 80-column terminal. */
  labelChars: 12,

  // --- Report budgeting (§3.7). BYTES. ---
  reportMaxBytes: 48_000,
  summaryMaxBytes: 6_000,
  /**
   * Floor a summary is trimmed TO, never below. A section trimmed to nothing is
   * indistinguishable from a child that reported nothing, which is exactly the
   * distinction the report exists to preserve.
   */
  summaryFloorBytes: 400,

  /** Deduped `write_file` / `edit_file` paths recorded per child (§3.4). */
  filesTouchedMax: 30,

  // --- The team bus (§3.6). The "bu neng tai pin fan" clause, in numbers. ---
  /** `team_send` calls one child may spend on a whole dispatch. */
  messagesPerAgent: 6,
  /** `team_send` calls the whole dispatch may spend. */
  messagesPerDispatch: 24,
  /** Minimum gap between one child's sends. */
  minSendIntervalMs: 15_000,
  /** Quota units a `to: "all"` broadcast costs. */
  broadcastCost: 2,
  subjectChars: 80,
  bodyChars: 800,
  /** `team_wait` timeout clamp, in seconds. */
  waitMinSeconds: 5,
  waitMaxSeconds: 120,
  waitDefaultSeconds: 30,

  /**
   * `agent_update` coalescing window (§5.2). Five children streaming tokens must
   * not push five React renders per token; phase transitions always pass.
   */
  agentUpdateThrottleMs: 120,

  /** Agent rows the live panel renders before collapsing to `+N more` (§6.1). */
  panelMaxRows: 5,
  /** Below this many terminal rows the panel collapses to its header line. */
  panelCollapseRows: 20,
  /** Below this many columns the status-bar readout degrades to `[3]` (D-20). */
  statusCompactCols: 100,

  // --- Live activity (team-live-activity F-1) ---
  /**
   * STORAGE ceiling for a prose activity tail (P0-1). The most a `SubagentRun`
   * may carry, NOT the width of the column: `TeamPanel.activityBudget(cols)`
   * derives the display budget from the terminal and is always <= this.
   */
  activityChars: 64,
  /**
   * Floor under `activityBudget`. Below roughly 46 columns the roster has bigger
   * problems than an elided activity line, and a column narrower than this shows
   * nothing but an ellipsis - at which point the phase word is more informative.
   */
  activityMinChars: 12,
  /** Rolling text buffer kept per child. The only per-token allocation. */
  activityTailChars: 160,
  /** Per picked tool argument (P1-4). A path or a command longer than this is
   *  elided on capture, so a run can never carry more than a few hundred bytes
   *  of argument however large the real call was. */
  activityArgChars: 120,
  /** At or above this many columns the activity line carries a full path or
   *  command; below it, a basename or a program name. Mirrors `statusCompactCols`.
   *  This chooses WHICH FACT to show; `activityBudget` chooses how much of it. */
  activityWideCols: 100,
  /**
   * Below this many columns the roster's activity cell gives way ENTIRELY
   * (tui-subagent-panel §4.2.2).
   *
   * STRUCTURAL, like everything else in this block: twelve characters of prose in
   * a 40-column terminal push the description column below its own twelve-column
   * floor, and "who is doing what" outranks "what they are writing right now" when
   * there is room for only one. That is why the cell returns 0 rather than
   * `activityMinChars` below this width.
   */
  activityDropCols: 56,
  /**
   * The same drop threshold when the row carries a persona-name cell
   * (`TEAM_NAME_CELLS` = 7 wider): `activityDropCols + 7`, so the activity cell
   * gives way at exactly the point it would have before the name column existed.
   */
  activityDropColsWithName: 63,

  // --- The Agents board (tui-subagent-panel §4.4 / §4.5) ---
  /**
   * Events kept per child in `SubagentRun.timeline` (§4.5.3). Twenty-four covers
   * a typical dispatch's complete tool sequence; ten children x 24 x 120 chars is
   * about 29 KB at peak, and the ring is EPHEMERAL - it never reaches a file.
   */
  timelineEntries: 24,
  /** Display clamp on one timeline line; the same order as `activityArgChars`. */
  timelineTextChars: 120,
  /**
   * Row ceiling of the Agents board's projection. The overlay scrolls, so this is
   * a memory bound rather than a fit: one row per fact and at most ten children
   * plus one detail section, which no healthy dispatch can reach.
   */
  boardMaxRows: 240,

  // --- Cold-start retry (team-live-activity F-4) ---
  /** Retries of a child that produced NOTHING. One, and not configurable: a
   *  second retry doubles the worst-case latency of a failing dispatch and buys
   *  nothing a re-dispatch by the lead would not buy better. */
  maxColdStartRetries: 1,
  retryBackoffMs: 2_000,

  // --- The dispatch supervisor (team-overseer / subagent-overseer-v2) ---
  /**
   * Wall-clock budget of everything one SINGLE inspection may carry (the
   * silence-triggered path). The digest holds run facts, the supervisor's own
   * memory and the tail of the child's live history; unbounded, one look at a
   * child that read five big files would make the "cheap" supervision call
   * cost more than the child (the argument FAST_LIMITS.digestMaxChars makes,
   * one level up).
   */
  overseerDigestBytes: 8_000,
  /** Clamp on a `nudge` guidance text. Advice, not a second brief. */
  overseerGuidanceChars: 1_200,
  /** Clamp on the decision `reason` recorded in the report. */
  overseerReasonChars: 200,
  /**
   * Per-child slice of a BATCH digest (D-3 / R-P2-5). 6.7x tighter than the
   * single-inspection budget above: a batch carries up to ten children in one
   * call, and memory plus the history tail are the first to give way (the
   * facts-first assembly order already puts them last).
   */
  overseerPerChildDigestBytes: 1_200,
  /** Whole-batch digest ceiling (D-3): 10 children x 1 200 B fits exactly. */
  overseerBatchDigestBytes: 12_000,
  /**
   * Output budget of ONE batch inspection (R-P0-1). The single-inspection path
   * keeps `FAST_LIMITS.reviewOutputTokens` (512); a batch must return up to
   * ten decision objects, and 512 tokens cannot physically hold ten x
   * (reason <= 200 + guidance <= 1200). A truncated batch reply fails
   * "first `[` to last `]`" parsing and degrades to all-wait - exactly the
   * failure this separate, larger budget exists to prevent.
   */
  overseerBatchOutputTokens: 2_048,
  /** Tighter `reason` clamp inside the batch protocol (R-P0-1). */
  overseerBatchReasonChars: 80,
  /** Tighter `guidance` clamp inside the batch protocol (R-P0-1). */
  overseerBatchGuidanceChars: 400,
  /**
   * LOOKS per child per dispatch (D-5). A look is cost, not mutation: every
   * inspection of a child - silence-triggered, cadence tick or post-mortem -
   * spends one, including a call that failed softly. Twelve with the cadence
   * ladder covers hours of healthy slow work; past the budget the supervisor
   * says so once (`trigger: 'quiet'`) and stops waking that child up.
   */
  overseerMaxLooksPerChild: 12,
  /**
   * LOOKS per dispatch, the fool-proof total (R-P1-6):
   * hardMaxSubagents x overseerMaxLooksPerChild = 120. A mathematical upper
   * bound, not a tuning knob - the per-child budget always binds first; this
   * one exists so a bug cannot loop calls forever. When it trips, the whole
   * MonitorLoop stops with one aggregate notice.
   */
  overseerMaxLooksPerDispatch: HARD_MAX_SUBAGENTS * OVERSEER_MAX_LOOKS_PER_CHILD,
  /**
   * NUDGES per child per dispatch (D-5). Advice is cheap but not free: a
   * supervisor that steers the same child forever is one that never decided.
   */
  overseerMaxNudgesPerChild: 3,
  /**
   * Rebuilds PER CHILD per dispatch. One: a replacement that also stalls dies
   * on its own watchdog rather than ping-ponging fresh children at a task the
   * supervisor already failed to rescue once.
   */
  overseerMaxReplacementsPerChild: 1,
  /**
   * Abandons PER CHILD per dispatch (D-5). One, so a supervisor that has
   * already given up on a brief cannot keep re-killing bodies of it.
   */
  overseerMaxAbandonsPerChild: 1,
  /**
   * Cadence ladder growth factor (D-2). Each no-action inspection schedules
   * the next `previous * ratio` out, so a healthy slow child is looked at
   * logarithmically in its run time rather than every five minutes.
   */
  overseerCadenceRatio: 1.6,
  /**
   * First cadence check when neither `team.overseerIntervalMs` nor
   * `team.subagentTimeoutMs` names one (the shipped defaults): the supervisor
   * still looks even when no ceiling was configured.
   */
  overseerDefaultCheckMs: 300_000,
  /** Clamp on a ladder step / model-chosen `nextCheckMs`, lower bound. */
  overseerNextCheckMinMs: 60_000,
  /** Clamp on a ladder step / model-chosen `nextCheckMs`, upper bound. */
  overseerNextCheckMaxMs: 900_000,
  /**
   * A child's OWN idle watchdog, multiplied by this while the supervisor is
   * active, so the soft silence inspection at `idleTimeoutMs` always precedes
   * the hard abort. The watchdog stays as the backstop for a child that
   * wedges past every inspection.
   */
  overseerWatchdogFactor: 4,
} as const;

/**
 * The pseudo-label the runtime's AGGREGATE supervisor notices travel under
 * (subagent-overseer-v2 D-5 / R-P1-6): the dispatch-total look-budget notice
 * is one fact about the whole roster, not a row any child owns. RESERVED at
 * normalization (`normalizeSubagentSpecs` seeds `dedupeLabel` with it), so a
 * spec asking for the bare label `team` is handed `team-2` instead - the
 * report ledger and the exec stream can then never attribute an aggregate
 * notice to a real child, or swallow that child's own quiet note.
 */
export const TEAM_AGGREGATE_LABEL = 'team';

/**
 * The two comm tools, which are POLICY-EXEMPT inside a child (§3.11).
 *
 * They are not in the lead's registered tool list, so evaluating them against
 * the lead's `allowed-tools` ceiling would refuse them and dead-end the channel
 * — the same dead end `SKILL_TOOL_FLOOR` exists to prevent one level up.
 *
 * Deliberately NOT added to `HOST_TOOL_NAMES` (P2-5). That constant answers
 * "can a skill's `allowed-tools` declaration ever take effect?", and these two
 * are never registered on a lead — so a skill naming them genuinely IS
 * unenforceable, and `aragon skills doctor` reporting it as such is correct
 * rather than a gap.
 */
export const TEAM_SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['team_send', 'team_wait']);

/**
 * Bumped whenever the wording of either prompt block changes, so a behaviour
 * report can be tied to a block revision with one grep.
 */
export const TEAM_BLOCK_VERSION = 'v3-2026-10';

// ---------------------------------------------------------------------------
// Forced team mode (`/team <brief>`, team-command-forced-dispatch §6.5).
//
// FOUR STRUCTURAL NUMBERS, here rather than in the modules that read them for
// the reason this file's header records: none of them is a user preference, and
// a `config.json` key for any of them would make "the model ignored the
// instruction" tunable by the person the instruction exists to protect.
// ---------------------------------------------------------------------------

/**
 * The version string on `<forced_team_mode>`'s first line.
 *
 * The block's words are a CONTRACT with the model, so a behaviour report ("it
 * still did the work itself") has to be tieable to one revision. Kept beside
 * `TEAM_BLOCK_VERSION` rather than reusing it: the two blocks answer different
 * questions ("can dispatch" versus "must dispatch") and a shared number would
 * name neither revision.
 */
export const FORCED_TEAM_BLOCK_VERSION = 'v1-2026-10';

/**
 * Length ceiling of the `<forced_team_mode>` text.
 *
 * THE FIRST BLOCK LENGTH IN THIS SUBSYSTEM THAT A TEST ASSERTS: the `<team_mode>`
 * block's 1200 is a comment in `team/prompt.ts`, and unifying the two is a
 * separate small refactor (deliberately out of scope here). Looser than 1200
 * because this block is only ever paid for while the session is ARMED, and it
 * carries three layers of instruction rather than one.
 */
export const FORCED_TEAM_BLOCK_MAX_CHARS = 1400;

/**
 * Fallback nudges per user turn. ONE, and not configurable.
 *
 * The gate exists because the first two layers (the directive and the prompt
 * block) both depend on the model cooperating. A second nudge would double the
 * worst case of a model that is simply not going to dispatch - at N children per
 * attempt - and D-8's whole argument is that the mechanical layer must be
 * bounded by something other than the model's willingness.
 */
export const FORCED_NUDGE_LIMIT = 1;

/**
 * Grace window before the fallback nudge fires, in milliseconds.
 *
 * SAME ORDER AS THE TODO FOLLOW-THROUGH GRACE, for a structural reason rather
 * than a stylistic one: both continuations share ONE `followTimer` in `App`
 * (I-9), so "at most one armed continuation" is only explicable while the two
 * numbers stay in the same order of magnitude. **Changing todo's grace means
 * re-reading this constant.**
 */
export const FORCED_NUDGE_GRACE_MS = 3000;
