/**
 * In-memory skill registry (spec §10.1). Pure state: no filesystem, no network.
 *
 * Precedence (D7) is decided by the ORDER records are added — the CLI scanner
 * walks roots low-to-high (bundled → user → project → env), so a later `add()`
 * of the same name wins and the loser is recorded in `shadowed[]` rather than
 * silently dropped. `/skills` renders that as `~shadowed by project`, which is
 * the difference between "my edit did nothing" being a mystery and being a
 * one-line answer.
 */

import { catalogRecords } from './disclosure.js';
import type { SkillRecord } from './types.js';

export class SkillRegistry {
  private readonly byName = new Map<string, SkillRecord>();

  /** Skills loaded via the `skill` tool during THIS session. */
  private readonly active = new Set<string>();

  // -------------------------------------------------------------------------
  // Frames (§5.1) — the turn-scoped source set behind the tool ceiling.
  //
  // NOT the same thing as `active`, and conflating them is the mistake this
  // split exists to prevent: `active` answers "has this body already been sent
  // in this conversation" and only ever grows, whereas a ceiling has to expire
  // the moment the user's intent changes. Two segments, because a slash command
  // submits the very message that opens the turn it must constrain (D-G2): it
  // QUEUES, and `beginUserTurn()` promotes.
  //
  // NAMES, NOT RECORDS (D-G20). `discover()` swaps the whole table via
  // `replaceAll()`, and it runs mid-turn — `/skills reload`, `/skills trust`,
  // any install. A held record reference would quietly become an orphan whose
  // `disabled` flag and integrity verdict are frozen in the past.
  // -------------------------------------------------------------------------

  private readonly frameActive = new Set<string>();
  private readonly framePending = new Set<string>();

  /**
   * Announce-once ledgers (§5.5 / P1-2). They live here rather than in the tool
   * wrapper because this class is already the sole authority on when a turn
   * begins — a `Set` closed over in `withToolPolicy` would be session-scoped and
   * would silence `warn` mode after its very first message.
   */
  private readonly warnedThisTurn = new Set<string>();
  private readonly failOpenNoticed = new Set<string>();
  private readonly deniedThisTurn = new Map<string, number>();

  /**
   * Insert a record, resolving a same-name collision in favour of the newcomer
   * (higher-precedence root) while preserving the loser as a shadow entry.
   */
  add(record: SkillRecord): void {
    const existing = this.byName.get(record.name);
    if (!existing) {
      this.byName.set(record.name, record);
      return;
    }
    // Highest-precedence loser first, so `/skills` can render "~shadowed by
    // <shadowed[0].scope>" without re-deriving the ordering.
    record.shadowed = [
      { scope: existing.scope, dir: existing.dir },
      ...existing.shadowed,
      ...record.shadowed,
    ];
    this.byName.set(record.name, record);
  }

  get(name: string): SkillRecord | undefined {
    return this.byName.get(name);
  }

  /** Every record, including disabled and invalid ones, sorted by name. */
  list(): SkillRecord[] {
    return Array.from(this.byName.values()).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  }

  names(): string[] {
    return this.list().map((r) => r.name);
  }

  /** Level 1-eligible records in canonical order (scope desc, then name asc). */
  catalog(): SkillRecord[] {
    return catalogRecords(Array.from(this.byName.values()));
  }

  /** Records that should be injected as Level 2 at session start (§5.4). */
  alwaysOn(extraNames: string[] = []): SkillRecord[] {
    const forced = new Set(extraNames);
    return Array.from(this.byName.values()).filter(
      (r) => !r.disabled && !r.invalid && (r.frontmatter.activation === 'always' || forced.has(r.name)),
    );
  }

  setDisabled(name: string, disabled: boolean): void {
    const record = this.byName.get(name);
    if (record) record.disabled = disabled;
  }

  /** Idempotent: marks a skill as loaded and reports whether it already was. */
  activate(name: string): boolean {
    const wasActive = this.active.has(name);
    this.active.add(name);
    return wasActive;
  }

  isActive(name: string): boolean {
    return this.active.has(name);
  }

  get activeNames(): string[] {
    return Array.from(this.active).sort();
  }

  /**
   * Drop the session's loaded-skill set. Called by `/reset` (P2-9) — without it
   * the "already loaded earlier in this conversation" hint would keep claiming
   * a skill is in a context that no longer exists.
   *
   * Clearing the frames here rather than at the call site is deliberate (§7.3):
   * "remember to call the other method too" is not a design, and the symptom of
   * forgetting — a ceiling surviving a `/reset` — would be attributed to
   * anything but this.
   */
  clearActive(): void {
    this.active.clear();
    this.clearFrames();
    this.failOpenNoticed.clear();
  }

  // -------------------------------------------------------------------------
  // Frame lifecycle (§5.1). Exactly four events move a name; there is no fifth.
  // -------------------------------------------------------------------------

  /** The `skill` tool succeeded: this skill constrains the turn from now on. */
  enterFrame(name: string): void {
    this.frameActive.add(name);
  }

  /** A `/<skill-name>` command ran: constrain the turn its message is about to open. */
  queueFrame(name: string): void {
    this.framePending.add(name);
  }

  /** A new user message arrived: the previous turn's ceiling expires, queued ones promote. */
  beginUserTurn(): void {
    this.frameActive.clear();
    for (const name of this.framePending) this.frameActive.add(name);
    this.framePending.clear();
    this.resetTurnLedgers();
  }

  /**
   * A user message arrived MID-RUN (`steer`). Promotes the queue without
   * clearing what is already in force (D-G3): the turn has not ended, so neither
   * has the skill procedure — and letting an interjection lift the ceiling would
   * make "ask a follow-up question" the documented way around it.
   *
   * The turn ledgers are deliberately NOT reset: this is the same turn.
   */
  absorbPendingFrames(): void {
    for (const name of this.framePending) this.frameActive.add(name);
    this.framePending.clear();
  }

  /** `/skills unload` — drops the ceiling. Does NOT reclaim context; nothing can. */
  clearFrames(): void {
    this.frameActive.clear();
    this.framePending.clear();
    this.resetTurnLedgers();
  }

  private resetTurnLedgers(): void {
    this.warnedThisTurn.clear();
    this.deniedThisTurn.clear();
  }

  get frameNames(): string[] {
    return Array.from(this.frameActive).sort();
  }

  /** Names queued by a slash command, awaiting the user message they will constrain. */
  get pendingFrameNames(): string[] {
    return Array.from(this.framePending).sort();
  }

  /**
   * The frame's records that STILL EXIST and are still usable.
   *
   * Unresolvable / disabled / invalid names are dropped from the result but KEPT
   * in `frameActive`, so `frameNames` can still say which skill was supposed to
   * be constraining this turn. The caller owes the user one notice per lifted
   * skill (§5.6f): uninstall, disable and a flip to `integrity: strict` all end
   * with the ceiling gone, and a ceiling that disappears without a word is the
   * exact failure class this whole iteration exists to remove.
   */
  frameRecords(): SkillRecord[] {
    const out: SkillRecord[] = [];
    for (const name of this.frameNames) {
      const record = this.byName.get(name);
      if (!record || record.disabled || record.invalid) continue;
      out.push(record);
    }
    return out;
  }

  /** True on the first `(skill, tool)` pair this TURN; false afterwards. */
  noteWarnOnce(skill: string, tool: string): boolean {
    const key = `${skill}::${tool}`;
    if (this.warnedThisTurn.has(key)) return false;
    this.warnedThisTurn.add(key);
    return true;
  }

  /** True on the first mention of `key` this SESSION; false afterwards. */
  noteFailOpenOnce(key: string): boolean {
    if (this.failOpenNoticed.has(key)) return false;
    this.failOpenNoticed.add(key);
    return true;
  }

  /** Count this refusal and return the running total for the tool, this turn. */
  countDeny(tool: string): number {
    const next = (this.deniedThisTurn.get(tool) ?? 0) + 1;
    this.deniedThisTurn.set(tool, next);
    return next;
  }

  /** Swap the whole table after a rescan, preserving the active set. */
  replaceAll(records: SkillRecord[]): void {
    this.byName.clear();
    for (const record of records) this.add(record);
  }
}
