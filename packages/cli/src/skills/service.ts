/**
 * SkillService — discovery, lazy loading, prompt-block assembly, and the
 * lifecycle surface the UI and the agent tools call into (spec §12.2).
 *
 * Everything mutating (install / create / remove) delegates to `installer.ts`;
 * this file owns the read side and the registry.
 */

import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  SkillRegistry,
  computeToolPolicy,
  parseFrontmatter,
  renderSkillCatalog,
  type SkillFileRef,
  type SkillHost,
  type SkillIntegrity,
  type SkillManifest,
  type SkillPlatform,
  type SkillPolicyView,
  type SkillRecord,
  type SkillScope,
  type SkillUsageMap,
  type SkillValidationIssue,
  type ToolPolicyDecision,
  type ToolPolicyVerdict,
} from '@argon-agent/core';
import {
  SKILL_FILES_MAX,
  SKILL_MD_MAX_BYTES,
  SKILL_SCAN_MAX_DIRS,
  SKILL_SCAN_SOFT_TIMEOUT_MS,
  STAGING_TTL_MS,
  TOOL_POLICY_DENY_ESCALATE_AT,
  normalizeFrontmatter,
  renderAlwaysSkills,
  renderDenyEscalation,
  renderDenyEscalationNotice,
  validateSkillFrontmatter,
} from '@argon-agent/core/skills';
import type { NoticeLevel } from '../agent/reducer.js';
import type { SkillsConfig, SkillsRuntimeOptions, SkillsToolPolicyMode } from '../config/schema.js';
import { SKILL_TOOL_FLOOR, type ConfirmRequest } from '../tools/index.js';
import { currentPlatform } from './node-host.js';
import { readManifest, sha256Buffer, sha256File } from './manifest.js';
import {
  isDirectory,
  normalizeTrustPath,
  resolveSkillRoots,
  getStagingDir,
  type SkillRoot,
} from './paths.js';
import { USAGE_MAX_ENTRIES, loadUsage, pruneUsage, recordUse } from './usage.js';

/**
 * Capability-probing approval gate (D17 / §8.3.1).
 *
 * NOT `confirm?: (req) => Promise<boolean>`. That shape cannot express "there is
 * no human here", and the CLI's existing confirm callback resolves `true` when
 * unattached (`cli.tsx`'s `confirmBridge.handler ? … : Promise.resolve(true)`).
 * Inheriting that fallback would make `requireApproval: true` a no-op under
 * `-p`, where the App never mounts and the handler is permanently null.
 * Probing FIRST makes fail-closed the default path rather than a discipline.
 */
export interface ApprovalGate {
  /** Is there a human channel RIGHT NOW? Must be read live, never cached (Q7). */
  canPrompt(): boolean;
  /** Only called when `canPrompt()` returned true. */
  request(req: ConfirmRequest): Promise<boolean>;
}

export interface DiscoverResult {
  records: SkillRecord[];
  errors: string[];
  /** Project roots skipped because the directory is not trusted yet (D13). */
  pendingTrust: string[];
}

export interface SkillServiceDeps {
  host: SkillHost;
  getCwd: () => string;
  config: SkillsConfig;
  runtime: SkillsRuntimeOptions;
  approval: ApprovalGate;
  /** → `controller.refreshSkills()`. */
  onChange?: () => void;
  notify?: (level: NoticeLevel, text: string) => void;
  /** Persist a skills patch. MUST deep-merge (§10.3.2). */
  persist?: (patch: Partial<SkillsConfig>) => void;
}

const ENTRY_FILE = 'SKILL.md';
const MANIFEST_FILE = '.argon-skill.json';
const BUNDLED_FILE_DEPTH = 3;

/** v1 left backups inside the skills root; skip them so they cannot resurrect (P1-6). */
const BAK_DIR_PATTERN = /\.bak-\d+$/;

export class SkillService {
  private readonly registry = new SkillRegistry();
  private config: SkillsConfig;
  private lastErrors: string[] = [];
  private pendingTrust: string[] = [];
  /** Empty when `skills.usageTracking` is off — which is exactly invariant I-A1. */
  private usage: SkillUsageMap = {};
  /** The integrity warning is worth saying once a session, not once a rescan. */
  private integrityWarned = false;

  /**
   * `/skills policy <mode>` writes here. `null` = this session has no opinion.
   * NEVER persisted — the config file is written separately by the same command.
   */
  private sessionToolPolicy: SkillsToolPolicyMode | null = null;

  /**
   * The previous decision, used to notice when the ceiling WIDENS (§5.6e).
   *
   * A skill can tell the model to load a second skill, and because the ceiling
   * is a union with `skill` permanently in the floor, that works (D-G17). The
   * path is not blocked — every way of blocking it costs more than it saves —
   * so instead it leaves a trace. This pair of fields is that trace's memory.
   */
  private lastDecisionAllowed: ReadonlySet<string> | null = null;
  private lastDecisionSources = new Set<string>();

  constructor(private readonly deps: SkillServiceDeps) {
    this.config = deps.config;
    if (this.config.usageTracking) this.usage = loadUsage();
  }

  // -----------------------------------------------------------------------
  // Discovery
  // -----------------------------------------------------------------------

  /**
   * Scan all four roots in ascending precedence and rebuild the registry.
   *
   * One unreadable directory must never sink the whole pass: every root and
   * every candidate is wrapped, and partial results are returned alongside the
   * errors so `/skills` can show both what loaded and what did not.
   */
  discover(): DiscoverResult {
    const errors: string[] = [];
    const pendingTrust: string[] = [];
    const records: SkillRecord[] = [];
    const startedAt = Date.now();

    this.reclaimStaleStaging();

    for (const root of resolveSkillRoots(this.deps.getCwd(), this.config.projectDirs)) {
      if (Date.now() - startedAt > SKILL_SCAN_SOFT_TIMEOUT_MS) {
        errors.push(`skill scan exceeded ${SKILL_SCAN_SOFT_TIMEOUT_MS}ms; remaining roots skipped`);
        break;
      }
      if (!isDirectory(root.dir)) continue;
      if (root.scope === 'project' && !this.isTrusted(root.dir)) {
        pendingTrust.push(root.dir);
        continue;
      }
      records.push(...this.scanRoot(root, errors));
    }

    this.registry.replaceAll(records);
    for (const name of this.config.disabled) this.registry.setDisabled(name, true);

    this.lastErrors = errors;
    this.pendingTrust = pendingTrust;

    this.pruneUsageIfOverCap();
    this.reportIntegrity();

    return { records: this.registry.list(), errors, pendingTrust };
  }

  /**
   * Enforce the usage-file cap (§9.2) — and ONLY when it is actually exceeded.
   *
   * `pruneUsage()` drops every counter whose skill is absent from the registry,
   * and the registry is CWD-DEPENDENT: it holds the `project` skills of
   * whichever directory this process happens to be running in. Calling it on
   * every scan would therefore make a session in repo B silently erase the
   * usage history of repo A — and a root that was momentarily unreadable would
   * erase all of it. Counters for uninstalled skills are worth a few hundred
   * bytes; the ranking signal they would take with them is not.
   */
  private pruneUsageIfOverCap(): void {
    if (!this.config.usageTracking) return;
    if (Object.keys(this.usage).length <= USAGE_MAX_ENTRIES) return;
    pruneUsage(this.registry.names());
  }

  /**
   * Tell the user once per session which skills no longer match what they
   * approved (`warn` mode only — `strict` already refuses them outright, and
   * repeating the notice on every rescan is how a warning becomes wallpaper).
   */
  private reportIntegrity(): void {
    if (this.config.integrity !== 'warn' || this.integrityWarned) return;
    const modified = this.registry
      .list()
      .filter((r) => r.integrity === 'modified')
      .map((r) => r.name);
    if (modified.length === 0) return;
    this.integrityWarned = true;
    this.deps.notify?.(
      'warn',
      `SKILL.md changed since install: ${modified.join(', ')}. ` +
        'Run "aragon skills doctor" for details, or "aragon skills update <name> --force" to restore.',
    );
  }

  /** Scan one root. Returns the records it yielded; appends to `errors` in place. */
  private scanRoot(root: SkillRoot, errors: string[]): SkillRecord[] {
    const out: SkillRecord[] = [];
    let entries: Array<{ name: string; isDirectory: boolean }>;
    try {
      entries = this.deps.host.listDir(root.dir);
    } catch (err) {
      errors.push(`cannot read skills root ${root.dir}: ${message(err)}`);
      return out;
    }

    const dirs = entries
      .filter((e) => e.isDirectory)
      .filter((e) => !e.name.startsWith('.'))
      .filter((e) => !BAK_DIR_PATTERN.test(e.name))
      // Deterministic order: the same-name tie-break below must not depend on
      // the platform's readdir sequence (§5.1 / §6.2 step 4).
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))
      .slice(0, SKILL_SCAN_MAX_DIRS);

    const seenInRoot = new Set<string>();
    for (const entry of dirs) {
      const dir = join(root.dir, entry.name);
      try {
        const record = this.readSkillDir(dir, entry.name, root);
        if (!record) continue;
        if (seenInRoot.has(record.name)) {
          errors.push(
            `duplicate skill name "${record.name}" in ${root.dir}; keeping the first directory in lexical order`,
          );
          continue;
        }
        seenInRoot.add(record.name);
        out.push(record);
      } catch (err) {
        errors.push(`skipping ${dir}: ${message(err)}`);
      }
    }
    return out;
  }

  /** Build a record from a candidate directory, or `null` when it is not a skill. */
  private readSkillDir(dir: string, dirName: string, root: SkillRoot): SkillRecord | null {
    const entryPath = join(dir, ENTRY_FILE);
    if (!this.deps.host.exists(entryPath)) return null;

    const bytes = statSync(entryPath).size;
    const issues: SkillValidationIssue[] = [];
    let source = '';
    let readOk = false;
    if (bytes > SKILL_MD_MAX_BYTES) {
      issues.push({
        level: 'error' as const,
        code: 'SKILL_MD_TOO_LARGE',
        message: `SKILL.md is ${bytes} bytes (max ${SKILL_MD_MAX_BYTES})`,
      });
    } else {
      source = this.deps.host.readTextFile(entryPath);
      readOk = true;
    }

    const parsed = source.length > 0 ? parseFrontmatter(source) : null;
    if (source.length > 0 && !parsed) {
      issues.push({
        level: 'error' as const,
        code: 'SKILL_FRONTMATTER_MISSING',
        message: 'SKILL.md has no parseable YAML frontmatter block',
      });
    }
    const data = parsed?.data ?? {};
    issues.push(...validateSkillFrontmatter(data, dirName));

    const frontmatter = normalizeFrontmatter(data, dirName);
    const manifest = readManifest(join(dir, MANIFEST_FILE));
    const integrity = readOk
      ? this.computeIntegrity(entryPath, source, manifest)
      : ('unverified' as const);

    // `strict` turns a mismatch into a validation error, which is what removes
    // the skill from the catalog, from the always-block, from `skill_find` and
    // from the dynamic slash commands — all of which already key off `invalid`.
    // Expressing it as an issue rather than four separate filters means a new
    // consumer cannot forget to honour it.
    if (integrity === 'modified' && this.config.integrity === 'strict') {
      issues.push({
        level: 'error' as const,
        code: 'SKILL_INTEGRITY_MISMATCH',
        message:
          'SKILL.md does not match the version that was approved at install time. ' +
          'Run "aragon skills doctor" to inspect it, or "aragon skills update <name> --force" to restore it.',
      });
    }

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      scope: root.scope,
      dir,
      entryPath,
      frontmatter,
      body: null,
      files: null,
      bytes,
      disabled: false,
      issues,
      invalid: issues.some((i) => i.level === 'error'),
      shadowed: [],
      manifest,
      writable: root.writable,
      integrity,
    };
  }

  /**
   * Compare SKILL.md against the hash recorded at install time (§8.1).
   *
   * Costs no extra read on the happy path: the text is already in memory from
   * the scan, and the manifest was already parsed.
   *
   * D-A12 — THE SECOND HASH IS NOT REDUNDANT. `readTextFile()` returns a
   * DECODED string. Re-encoding it round-trips byte-for-byte only for
   * well-formed UTF-8; a file containing an invalid sequence comes back with
   * U+FFFD substituted, so the re-encoded bytes differ from what is on disk and
   * an untouched file would be reported as tampered. A false alarm here is
   * worse than no alarm at all — it teaches the user that this warning is noise,
   * and it is the same warning that has to be believed on the day it is real.
   */
  private computeIntegrity(
    entryPath: string,
    sourceText: string,
    manifest: SkillManifest | null,
  ): SkillIntegrity {
    if (!manifest || this.config.integrity === 'off') return 'unverified';
    const entry = manifest.files.find((f) => f.path === ENTRY_FILE);
    if (!entry) return 'unverified';
    if (sha256Buffer(Buffer.from(sourceText, 'utf-8')) === entry.sha256) return 'ok';
    try {
      return sha256File(entryPath) === entry.sha256 ? 'ok' : 'modified';
    } catch {
      return 'modified';
    }
  }

  /** Reload from disk and notify the controller so the prompt is rebuilt. */
  reload(): DiscoverResult {
    const result = this.discover();
    this.deps.onChange?.();
    return result;
  }

  // -----------------------------------------------------------------------
  // Read surface
  // -----------------------------------------------------------------------

  list(): SkillRecord[] {
    return this.registry.list();
  }

  get(name: string): SkillRecord | undefined {
    return this.registry.get(name);
  }

  getRegistry(): SkillRegistry {
    return this.registry;
  }

  errors(): string[] {
    return this.lastErrors;
  }

  /** Project roots the trust gate is still holding back (§9.3). */
  untrustedDirs(): string[] {
    return this.pendingTrust;
  }

  /**
   * Level 2 load: SKILL.md body + the bundled-file listing.
   * MAY THROW — see the `SkillHost` error contract; `skill`'s `execute()` and
   * every UI caller wrap this.
   *
   * THE SINGLE USAGE MEASUREMENT POINT (F8). All three consumption paths — the
   * `skill` tool, a `/<skill-name>` command, and `alwaysBlock()` — funnel
   * through here, so one call site covers everything.
   *
   * `countUse: false` is MANDATORY for `alwaysBlock()`. An always-on skill is
   * injected automatically on every single turn; counting that would pin it to
   * the top of the ranking forever and drown out the signal the ranking exists
   * to capture, which is what a human or a model actually CHOSE to reach for.
   */
  loadBody(name: string, opts: { countUse?: boolean } = {}): { body: string; files: SkillFileRef[] } {
    const record = this.registry.get(name);
    if (!record) throw new Error(`unknown skill "${name}"`);
    const source = this.deps.host.readTextFile(record.entryPath);
    const parsed = parseFrontmatter(source);
    if (opts.countUse !== false && this.config.usageTracking) recordUse(name);
    return { body: parsed ? parsed.body : source, files: this.listSkillFiles(record.dir) };
  }

  /** Walk a skill directory for bundled resources (depth ≤ 3, dotfiles skipped). */
  private listSkillFiles(dir: string, prefix = '', depth = 0): SkillFileRef[] {
    if (depth >= BUNDLED_FILE_DEPTH) return [];
    let entries: Array<{ name: string; isDirectory: boolean; bytes: number }>;
    try {
      entries = this.deps.host.listDir(dir);
    } catch {
      return [];
    }
    const out: SkillFileRef[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === ENTRY_FILE && prefix === '') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        out.push(...this.listSkillFiles(join(dir, entry.name), rel, depth + 1));
      } else {
        out.push({ path: rel, bytes: entry.bytes });
      }
      if (out.length > SKILL_FILES_MAX * 2) break;
    }
    return out;
  }

  // -----------------------------------------------------------------------
  // Prompt blocks
  // -----------------------------------------------------------------------

  /** Level 1 catalog for the system prompt, or `''` when there is nothing to say. */
  catalogBlock(): string {
    if (!this.config.enabled) return '';
    return renderSkillCatalog(this.registry.list(), {
      maxBytes: this.config.catalogMaxBytes,
      // Omitted entirely when tracking is off, which is what makes the order
      // degrade to the pre-ranking one byte for byte (I-A1).
      ...(this.config.usageTracking ? { usage: this.usage } : {}),
    });
  }

  /**
   * `activation: always` bodies plus anything forced with `--skill`.
   * Returns `''` when empty so the caller can concatenate unconditionally
   * without disturbing invariant I-S1.
   */
  alwaysBlock(): string {
    if (!this.config.enabled) return '';
    const records = this.registry.alwaysOn(this.deps.runtime.forcedSkills);
    if (records.length === 0) return '';

    // Bodies are lazy by default (Level 2 is normally reached through the
    // `skill` tool). Always-on skills are the one case where the body is needed
    // at prompt-build time, so hydrate here — rendering the unhydrated record
    // would emit a well-formed but EMPTY <skill> block, which looks like a
    // working feature and teaches the model nothing.
    const hydrated: SkillRecord[] = [];
    for (const record of records) {
      if (record.body === null) {
        try {
          // countUse: false — see the `loadBody` contract. This injection is
          // automatic, not a choice, and must not colour the ranking.
          const loaded = this.loadBody(record.name, { countUse: false });
          record.body = loaded.body;
          record.files = loaded.files;
        } catch (err) {
          this.lastErrors = [...this.lastErrors, `cannot load always-on skill ${record.name}: ${message(err)}`];
          continue;
        }
      }
      hydrated.push(record);
    }
    if (hydrated.length === 0) return '';

    // `platform` YES, `policy` NEVER (D-G18 / AC-G24).
    //
    // D-G9 keeps these skills out of the frame, so they impose no ceiling. Saying
    // otherwise here would repeat "only these tools are permitted" in the system
    // prompt on every single turn, for a restriction that does not exist, with
    // nothing in the UI pointing at the frontmatter line responsible. Note the
    // guarantee is structural, not a habit: `renderAlwaysSkills` has no `policy`
    // field to pass, so this cannot regress by accident.
    const block = renderAlwaysSkills(hydrated, {
      bodyMaxBytes: this.config.bodyMaxBytes,
      platform: this.platform(),
    });
    return block.length > 0 ? `\n${block}` : '';
  }

  /** Host shell family, forwarded into every Level 2 / Level 3 render (D-G14). */
  platform(): SkillPlatform {
    return currentPlatform();
  }

  // -----------------------------------------------------------------------
  // Tool ceiling (§5)
  // -----------------------------------------------------------------------

  /**
   * The mode actually in force, and where it came from.
   *
   * THREE LAYERS, not two (D-G19). `SkillsRuntimeOptions` is read-only for the
   * life of the session, so with only `flag > config` a user who started with
   * `--skill-tool-policy enforce` could run the very command the refusal text
   * recommends — `/skills policy off` — and have precisely nothing happen, with
   * no message either. An iteration about silent failures cannot ship one in its
   * own escape hatch.
   */
  effectiveToolPolicy(): { mode: SkillsToolPolicyMode; from: 'session' | 'flag' | 'config' } {
    if (this.sessionToolPolicy !== null) return { mode: this.sessionToolPolicy, from: 'session' };
    const flag = this.deps.runtime.toolPolicy;
    if (flag) return { mode: flag, from: 'flag' };
    return { mode: this.config.toolPolicy, from: 'config' };
  }

  setSessionToolPolicy(mode: SkillsToolPolicyMode): void {
    this.sessionToolPolicy = mode;
  }

  /** `/skills policy <mode>` — session slot and config file, together. */
  persistToolPolicy(mode: SkillsToolPolicyMode): void {
    this.updateConfig({ toolPolicy: mode });
  }

  /**
   * Compute the ceiling for right now. Constant-time when the frame is empty or
   * the mode is `off`, which is the overwhelmingly common case on the hot path.
   */
  toolPolicyDecision(getRegistered: () => readonly string[]): ToolPolicyDecision {
    const mode = this.effectiveToolPolicy().mode;
    if (!this.config.enabled) {
      return { mode: 'off', allowed: null, sources: [], sourceNames: [], ignored: [] };
    }
    const registered = getRegistered();
    const decision = computeToolPolicy({
      frame: this.registry.frameRecords(),
      registered,
      // Intersected with what is registered so `--no-skills`-style setups cannot
      // advertise `skill` / `skill_find` in a permitted set that does not contain
      // them. A phantom tool in that list is a small lie the model would act on.
      floor: SKILL_TOOL_FLOOR.filter((n) => registered.includes(n)),
      mode,
    });

    this.reportCeilingLifted();
    this.reportFailOpen(decision);
    this.reportCeilingWidened(decision);
    return decision;
  }

  /** The renderer-facing slice of the current decision, or `undefined` for "say nothing". */
  toolPolicyView(getRegistered: () => readonly string[]): SkillPolicyView | undefined {
    return toView(this.toolPolicyDecision(getRegistered));
  }

  /**
   * The ceiling a QUEUED skill is about to impose — for the `/<skill-name>` path,
   * whose message has not been submitted yet and whose frame is therefore still
   * pending (§13.2).
   *
   * Computed from the pending set alone, which is exactly right for the common
   * case (`controller.prompt()` replaces the frame with the pending one). When
   * the agent happens to be running, `steer()` unions instead, so this can
   * understate — it will never claim a tool is forbidden that is in fact allowed
   * only because some other skill is also in the frame. Overstating would be the
   * dangerous direction; a refusal, if one ever happens, prints the true set.
   *
   * Emits no announcements: nothing has been decided yet.
   */
  pendingToolPolicyView(getRegistered: () => readonly string[]): SkillPolicyView | undefined {
    const pending = this.registry.pendingFrameNames
      .map((name) => this.registry.get(name))
      .filter((r): r is SkillRecord => !!r && !r.disabled && !r.invalid);
    if (pending.length === 0) return undefined;
    const registered = getRegistered();
    return toView(
      computeToolPolicy({
        frame: pending,
        registered,
        floor: SKILL_TOOL_FLOOR.filter((n) => registered.includes(n)),
        mode: this.effectiveToolPolicy().mode,
      }),
    );
  }

  /**
   * One notice per skill per session when a frame member stops constraining
   * because it was uninstalled, disabled, or turned invalid (D-G20 / AC-G21).
   *
   * Without this, `/skills disable`, a `/skills reload` after an uninstall, and a
   * flip to `integrity: strict` each end with the ceiling gone and nothing said
   * — a silent lift, which is the same failure class as the silent no-op this
   * whole iteration set out to remove.
   */
  private reportCeilingLifted(): void {
    for (const name of this.registry.frameNames) {
      const record = this.registry.get(name);
      if (record && !record.disabled && !record.invalid) continue;
      // A skill that never declared anything was never contributing, so its
      // disappearance lifts nothing and is not worth a line.
      if (record && record.frontmatter.allowedTools.length === 0) continue;
      if (!this.registry.noteFailOpenOnce(`lifted:${name}`)) continue;
      this.deps.notify?.(
        'warn',
        `Tool ceiling lifted: skill "${name}" is no longer available (uninstalled/disabled).`,
      );
    }
  }

  /** One notice per skill per session when D-G4 waives it (§5.7 / RG3). */
  private reportFailOpen(decision: ToolPolicyDecision): void {
    for (const entry of decision.ignored) {
      if (!this.registry.noteFailOpenOnce(`failopen:${entry.name}`)) continue;
      this.deps.notify?.(
        'warn',
        `Skill "${entry.name}" declares tools this host does not recognise ` +
          `(${entry.unresolved.join(', ')}), so it is NOT ENFORCEABLE and imposes no tool ceiling. ` +
          'Run "aragon skills doctor" for details.',
      );
    }
  }

  /** Print the union-escalation trace (§5.6e / D-G17) and remember the new state. */
  private reportCeilingWidened(decision: ToolPolicyDecision): void {
    const previous = this.lastDecisionAllowed;
    if (decision.allowed !== null && previous !== null) {
      const added = [...decision.allowed]
        .filter((tool) => !previous.has(tool))
        .sort((a, b) => a.localeCompare(b, 'en'));
      if (added.length > 0) {
        const fresh = decision.sourceNames.filter((n) => !this.lastDecisionSources.has(n));
        const by = (fresh.length > 0 ? fresh : decision.sourceNames).join('", "');
        this.deps.notify?.(
          'warn',
          `Tool ceiling widened by skill "${by}": ${added.map((t) => `+${t}`).join(', ')}`,
        );
      }
    }
    this.lastDecisionAllowed = decision.allowed;
    this.lastDecisionSources = new Set(decision.sourceNames);
  }

  /**
   * The single place the three announce-once rules live (§5.4c / P1-2).
   *
   * `verdict.message` is MUTATED in the escalate branch rather than being
   * followed by a second message: the model is already reading this text, and a
   * separate message is one more thing for it to skip.
   */
  reportToolPolicyEvent(e: {
    tool: string;
    verdict: ToolPolicyVerdict;
    sourceNames: string[];
  }): void {
    // A blocked tool with several sources still needs ONE bucket key. Attribution
    // lives in `message`, which lists every source; this is only about how often
    // the same complaint reaches the transcript.
    const primary = e.sourceNames[0] ?? 'skill';

    if (e.verdict.allow) {
      if (!this.registry.noteWarnOnce(primary, e.tool)) return;
      if (e.verdict.notice) this.deps.notify?.('warn', e.verdict.notice);
      return;
    }

    if (e.verdict.notice) this.deps.notify?.('error', e.verdict.notice);
    const count = this.registry.countDeny(e.tool);
    if (count === TOOL_POLICY_DENY_ESCALATE_AT) {
      e.verdict.message = `${e.verdict.message ?? ''}\n${renderDenyEscalation(e.tool, count)}`;
      this.deps.notify?.('warn', renderDenyEscalationNotice(primary, e.tool, count));
    }
  }

  // Frame lifecycle — thin forwards so the controller never reaches into the
  // registry itself (`controller.ts` owns *when*, this class owns *what*).

  beginUserTurn(): void {
    this.registry.beginUserTurn();
    this.lastDecisionAllowed = null;
    this.lastDecisionSources = new Set();
  }

  absorbPendingFrames(): void {
    this.registry.absorbPendingFrames();
  }

  queueFrame(name: string): void {
    this.registry.queueFrame(name);
  }

  clearFrames(): void {
    this.registry.clearFrames();
    this.lastDecisionAllowed = null;
    this.lastDecisionSources = new Set();
  }

  frameNames(): string[] {
    return this.registry.frameNames;
  }

  /** Level 2 body budget — shared by the tool path and the slash path (GG3). */
  bodyMaxBytes(): number {
    return this.config.bodyMaxBytes;
  }

  /** Warn once about `--skill <name>` values that match nothing (§7.5). */
  reportUnknownForcedSkills(): void {
    for (const name of this.deps.runtime.forcedSkills) {
      if (!this.registry.get(name)) {
        this.deps.notify?.('warn', `--skill "${name}" does not match any installed skill.`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Mutators
  // -----------------------------------------------------------------------

  setDisabled(name: string, disabled: boolean): void {
    this.registry.setDisabled(name, disabled);
    const next = new Set(this.config.disabled);
    if (disabled) next.add(name);
    else next.delete(name);
    this.updateConfig({ disabled: [...next] });
    this.deps.onChange?.();
  }

  getConfig(): SkillsConfig {
    return this.config;
  }

  /** Local use counters backing `--sort=recent`; empty when tracking is off. */
  getUsage(): SkillUsageMap {
    return this.config.usageTracking ? this.usage : {};
  }

  /** Working directory an install should resolve `--scope project` against. */
  getCwdForInstall(): string {
    return this.deps.getCwd();
  }

  getRuntime(): SkillsRuntimeOptions {
    return this.deps.runtime;
  }

  getApproval(): ApprovalGate {
    return this.deps.approval;
  }

  notify(level: NoticeLevel, text: string): void {
    this.deps.notify?.(level, text);
  }

  /** Keep the in-memory copy and the config file in step (deep-merged, §10.3.2). */
  private updateConfig(patch: Partial<SkillsConfig>): void {
    this.config = { ...this.config, ...patch };
    this.deps.persist?.(patch);
  }

  // -----------------------------------------------------------------------
  // Directory trust (D13 / §9.3)
  // -----------------------------------------------------------------------

  isTrusted(dir: string): boolean {
    const normalized = normalizeTrustPath(dir);
    if (!normalized) return false;
    return this.config.trustedProjectDirs.some((t) => normalizeTrustPath(t) === normalized);
  }

  trustDir(dir: string): boolean {
    const normalized = normalizeTrustPath(dir);
    if (!normalized) return false;
    if (this.config.trustedProjectDirs.includes(normalized)) return true;
    this.updateConfig({ trustedProjectDirs: [...this.config.trustedProjectDirs, normalized] });
    return true;
  }

  untrustDir(dir: string): boolean {
    const normalized = normalizeTrustPath(dir) ?? dir;
    const next = this.config.trustedProjectDirs.filter(
      (t) => (normalizeTrustPath(t) ?? t) !== normalized,
    );
    if (next.length === this.config.trustedProjectDirs.length) return false;
    this.updateConfig({ trustedProjectDirs: next });
    return true;
  }

  /**
   * Load a project root for THIS SESSION ONLY, without persisting trust.
   * Used when the user answers the confirm dialog with "just this once".
   */
  trustForSession(dir: string): void {
    this.pendingTrust = this.pendingTrust.filter((d) => d !== dir);
    const root: SkillRoot = { dir, scope: 'project', writable: dir.includes('.argon') };
    const errors: string[] = [];
    for (const record of this.scanRoot(root, errors)) this.registry.add(record);
    for (const name of this.config.disabled) this.registry.setDisabled(name, true);
    this.lastErrors = [...this.lastErrors, ...errors];
    this.deps.onChange?.();
  }

  // -----------------------------------------------------------------------
  // Housekeeping
  // -----------------------------------------------------------------------

  /**
   * Drop staging directories left behind by a crashed install (P2-10).
   * Same discipline as the host repo's workspace cleanup: age-based, best
   * effort, and never allowed to interrupt discovery.
   */
  private reclaimStaleStaging(): void {
    const staging = getStagingDir();
    if (!isDirectory(staging)) return;
    const cutoff = Date.now() - STAGING_TTL_MS;
    let entries: Array<{ name: string; isDirectory: boolean }>;
    try {
      entries = this.deps.host.listDir(staging);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const dir = join(staging, entry.name);
      try {
        if (statSync(dir).mtimeMs >= cutoff) continue;
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort: a locked directory is retried on the next launch.
      }
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Decision → the flat, sorted shape the renderers take. `null` means "say nothing". */
function toView(decision: ToolPolicyDecision): SkillPolicyView | undefined {
  if (decision.allowed === null) return undefined;
  return {
    mode: decision.mode,
    allowed: [...decision.allowed].sort((a, b) => a.localeCompare(b, 'en')),
  };
}
