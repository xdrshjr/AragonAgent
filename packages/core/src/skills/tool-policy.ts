/**
 * The turn-scoped tool ceiling (spec §5) — what turns `allowed-tools` from a
 * decorative frontmatter field into an executable declaration.
 *
 * PURE FUNCTIONS ONLY. This module does not know which tools the host has; the
 * caller passes `registered` and `floor` in (D-G7). Core owns the SKILL.md
 * FORMAT — which includes knowing that `Read` is what Claude Code calls its
 * read-a-file tool — while the CLI owns the inventory of what actually exists.
 *
 * THE DIRECTION OF FAILURE IS THE WHOLE DESIGN (D-G4). A declaration this host
 * cannot fully resolve waives that skill's contribution ENTIRELY rather than
 * narrowing it: honouring the half we understood would silently constrain an
 * author to something they never wrote, and the reason (one mistyped tool name)
 * would be invisible. Fail-open plus a loud notice is correct here; the
 * fail-closed rule lives on the install gate, where the adversary is a person
 * rather than a typo.
 */

import { TOOL_POLICY_DENY_ESCALATE_AT } from './constants.js';
import type {
  SkillRecord,
  ToolPolicyDecision,
  ToolPolicyInput,
  ToolPolicySource,
  ToolPolicyVerdict,
} from './types.js';

// ---------------------------------------------------------------------------
// Name resolution (§5.3)
// ---------------------------------------------------------------------------

/** Lower-case and strip `_`, `-` and whitespace: `Read`→`read`, `read_file`→`readfile`. */
export function normalizeToolAlias(name: string): string {
  return name.toLowerCase().replace(/[_\-\s]/g, '');
}

/**
 * Claude Code's vocabulary → this host's snake_case names.
 *
 * Keys are already normalized. This table is why `.claude/skills` interop — the
 * README's headline feature — survives enforcement at all: without it every
 * community declaration (`allowed-tools: [Read, Bash]`) would resolve to nothing
 * and every such skill would take the fail-open path, making the whole ceiling
 * ornamental (FG2 / RG2).
 */
export const SKILL_TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  read: 'read_file',
  readfile: 'read_file',
  view: 'read_file',
  cat: 'read_file',

  write: 'write_file',
  writefile: 'write_file',
  create: 'write_file',

  edit: 'edit_file',
  editfile: 'edit_file',
  multiedit: 'edit_file',
  strreplaceeditor: 'edit_file',
  strreplacebasededitor: 'edit_file',

  bash: 'bash',
  shell: 'bash',
  sh: 'bash',
  runcommand: 'bash',
  terminal: 'bash',

  ls: 'list_dir',
  listdir: 'list_dir',
  listdirectory: 'list_dir',

  glob: 'glob',
  findfiles: 'glob',

  grep: 'grep',
  search: 'grep',
  ripgrep: 'grep',

  skill: 'skill',
  skillfind: 'skill_find',
  skillinstall: 'skill_install',
  skillcreate: 'skill_create',
});

/**
 * Capabilities this host simply does not have. A declaration naming one is
 * DROPPED, not treated as unresolvable (D-G5).
 *
 * If these counted as "cannot resolve", nearly every community skill would take
 * the fail-open path and enforcement would be theatre. Dropping them changes no
 * executable set — the model could never have called them — while leaving the
 * rest of the declaration in force. That is precision, not a concession.
 *
 * THIS TABLE ONLY GROWS. Removing an entry pushes already-working skills into
 * fail-open with no symptom whatsoever.
 */
export const SKILL_TOOL_KNOWN_ABSENT: ReadonlySet<string> = new Set([
  'webfetch',
  'websearch',
  'task',
  'agent',
  'todowrite',
  'todoread',
  'notebookedit',
  'notebookread',
  'bashoutput',
  'killshell',
  'slashcommand',
  'exitplanmode',
  'askuserquestion',
  'computer',
]);

/**
 * Resolve one declared name against the live tool list.
 *
 *   `string`   — a tool on this host.
 *   `'absent'` — a real Claude Code tool this host lacks; drop it silently.
 *   `null`     — unrecognisable; the whole skill then waives its contribution.
 *
 * THE ORDER OF THE FOUR STEPS IS THE SEMANTICS — do not reshuffle it. Exact
 * match first means a host that adds a new tool needs no table maintenance. The
 * alias table is consulted BEFORE the absent table so that mistakenly listing a
 * tool this host actually has could never silently downgrade a skill.
 */
export function resolveDeclaredTool(
  name: string,
  registered: readonly string[],
): string | 'absent' | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;

  // 1. Exact match against what is registered right now.
  if (registered.includes(trimmed)) return trimmed;

  const key = normalizeToolAlias(trimmed);

  // 2. Known alias. Resolving to a tool this host does NOT have is a miss, not a
  //    drop: the author asked for a capability we cannot grant, and pretending
  //    otherwise would narrow their declaration behind their back.
  const candidate = SKILL_TOOL_ALIASES[key];
  if (candidate !== undefined) return registered.includes(candidate) ? candidate : null;

  // 3. A real tool elsewhere that does not exist here.
  if (SKILL_TOOL_KNOWN_ABSENT.has(key)) return 'absent';

  // 4. Anything else — a typo, or a tool nobody here has heard of.
  return null;
}

// ---------------------------------------------------------------------------
// Decision (§5.2)
// ---------------------------------------------------------------------------

function noCeiling(
  mode: ToolPolicyDecision['mode'],
  ignored: ToolPolicyDecision['ignored'] = [],
): ToolPolicyDecision {
  return { mode, allowed: null, sources: [], sourceNames: [], ignored };
}

function contributes(record: SkillRecord): boolean {
  if (record.disabled || record.invalid) return false;
  // Redundant with the frame's own gate, and deliberately so (D-G9): an
  // `activation: always` skill is ambient reference material, not a procedure
  // the model chose to run, so it must never constrain a turn.
  if (record.frontmatter.activation === 'always') return false;
  return record.frontmatter.allowedTools.length > 0;
}

/**
 * Compute the ceiling for a turn.
 *
 * TWO INVARIANTS THIS FUNCTION OWNS (I-G1 / I-G2, pinned by AC-G23):
 *
 *   I-G1  `registered.length === 0` ⇒ `allowed === null`.
 *   I-G2  `allowed !== null` ⇒ the set is NON-EMPTY.
 *
 * Both matter because the failure they exclude is catastrophic and silent: an
 * empty permitted set is not "a tight ceiling", it is an agent that can no
 * longer do anything, for a reason no user could ever guess. The construction
 * makes them hold — every unresolved name waives its whole skill, and the final
 * guard below refuses to hand back an empty set — rather than leaving them to be
 * re-derived by whoever refactors this next.
 */
export function computeToolPolicy(input: ToolPolicyInput): ToolPolicyDecision {
  const { mode, registered, floor } = input;
  if (mode === 'off') return noCeiling(mode);

  const sources: ToolPolicySource[] = [];
  const ignored: ToolPolicyDecision['ignored'] = [];
  const granted = new Set<string>();

  for (const record of input.frame) {
    if (!contributes(record)) continue;

    const declared = record.frontmatter.allowedTools;
    const resolved: string[] = [];
    const unresolved: string[] = [];
    for (const declaredName of declared) {
      const outcome = resolveDeclaredTool(declaredName, registered);
      if (outcome === null) unresolved.push(declaredName);
      else if (outcome !== 'absent') resolved.push(outcome);
    }

    if (unresolved.length > 0) {
      ignored.push({ name: record.name, unresolved });
      continue;
    }

    for (const toolName of resolved) granted.add(toolName);
    sources.push({
      name: record.name,
      declared: [...declared],
      granted: [...new Set(resolved)].sort((a, b) => a.localeCompare(b, 'en')),
    });
  }

  if (sources.length === 0) return noCeiling(mode, ignored);

  sources.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const allowed = new Set<string>([...floor, ...granted]);

  // I-G2's structural guard. Reachable only when the floor is empty AND every
  // declaration resolved to `absent` — pathological, but the consequence would
  // be a fully locked agent, so it is checked rather than argued about.
  if (allowed.size === 0) return noCeiling(mode, ignored);

  return { mode, allowed, sources, sourceNames: sources.map((s) => s.name), ignored };
}

// ---------------------------------------------------------------------------
// Verdict (§5.2)
// ---------------------------------------------------------------------------

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * How to name the skills responsible, for both the model and the user.
 *
 * Multi-source turns list EVERY name. Picking one would be wrong in some
 * arrangement of skills every time, and a confidently wrong attribution is worse
 * than a slightly longer sentence.
 */
function describeSources(names: string[]): string {
  if (names.length === 1) return `skill "${names[0]}"`;
  return `skills ${names.map((n) => `"${n}"`).join(', ')}`;
}

/** The union of what the frame's skills actually asked for, floor excluded. */
function grantedUnion(decision: ToolPolicyDecision): string[] {
  return sorted(new Set(decision.sources.flatMap((s) => s.granted)));
}

/**
 * Decide a single call. Deterministic, allocation-light, and safe to run on
 * every tool invocation — `allowed === null` short-circuits before any string
 * work, which is the common case.
 */
export function evaluateToolCall(tool: string, d: ToolPolicyDecision): ToolPolicyVerdict {
  if (d.allowed === null || d.allowed.has(tool)) return { allow: true };

  const subject = describeSources(d.sourceNames);
  const declaredList = grantedUnion(d).join(', ');

  if (d.mode === 'warn') {
    return {
      allow: true,
      notice:
        `${tool} is outside the tool ceiling of ${subject} (declared: ${declaredList}). ` +
        'Running it anyway - skills.toolPolicy is "warn".',
    };
  }

  const message = [
    `Tool "${tool}" is not permitted while ${subject} is in effect.`,
    // The RAW declaration, not the mapped names: the author has to be able to
    // find this word in the frontmatter line they wrote.
    ...d.sources.map((s) => `- "${s.name}" declares allowed-tools: ${s.declared.join(', ')}`),
    `Permitted right now: ${sorted(d.allowed).join(', ')}.`,
    `Use one of those, or tell the user "${tool}" must be added to allowed-tools.`,
    'Do not retry this tool for the rest of this turn.',
  ].join('\n');

  return {
    allow: false,
    message,
    notice:
      `Blocked ${tool}: ${subject} limits this turn to ${declaredList}. ` +
      'Run /skills policy off to disable.',
  };
}

/**
 * The line appended to a refusal once the same tool has been refused
 * `TOOL_POLICY_DENY_ESCALATE_AT` times in one turn (§5.5).
 *
 * Appended to the SAME message rather than emitted as a new one: a second
 * message would be one more thing for the model to skim past, whereas a longer
 * version of the text it is already reading is unavoidable.
 */
export function renderDenyEscalation(tool: string, count: number): string {
  return (
    `You have now been refused "${tool}" ${count} times this turn. Stop calling it; ` +
    "tell the user which tool the skill's allowed-tools is missing."
  );
}

/** The matching one-liner for the user, emitted once per (turn, tool). */
export function renderDenyEscalationNotice(skill: string, tool: string, count: number): string {
  return (
    `Skill "${skill}" blocked ${tool} ${count}x this turn - the skill's allowed-tools ` +
    'may be wrong (/skills policy off to bypass).'
  );
}

export { TOOL_POLICY_DENY_ESCALATE_AT };
