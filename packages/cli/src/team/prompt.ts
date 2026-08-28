/**
 * The two system-prompt blocks team mode adds (team-subagents §4.6).
 *
 * ASCII ONLY: `src/team/**` is inside the glyph scanner's scope, and these
 * strings also reach a model that may be running in a `cmd.exe` terminal.
 *
 * BOTH BLOCKS ARE SPLICED CONDITIONALLY by `buildSystemPrompt`, which is what
 * preserves invariant I-8: with team mode off the prompt is BYTE-IDENTICAL to
 * the pre-team output for a fixed tool array. An unconditional guidance line
 * anywhere here would quietly break `--no-team`, `--no-skills` and the plan-mode
 * snapshot all at once.
 *
 * `TEAM_BLOCK_VERSION` exists so a change to this wording is greppable from a
 * behaviour report.
 */

import { TEAM_BLOCK_VERSION, TEAM_LIMITS } from './limits.js';

export { TEAM_BLOCK_VERSION };

export interface TeamBlockParams {
  maxSubagents: number;
  maxConcurrent: number;
  /**
   * Whether `model:"fast"` is honoured on `task` right now (fast-model-tier
   * §3.8).
   *
   * ONE SENTENCE, AND ONLY WHEN IT IS TRUE. `<fast_tier>` carries the full
   * guidance; this is the cross-reference that stops a model reading
   * `<team_mode>` in isolation and concluding every child costs the same. With
   * it absent the block is BYTE-IDENTICAL to the pre-feature output, which is
   * what `--no-fast` and every existing snapshot depend on.
   */
  fastDelegation?: boolean;
}

/**
 * The lead's `<team_mode>` block. Under 1200 characters on purpose: it is paid
 * for on EVERY turn of every team-enabled session, so anything that does not
 * change a delegation decision does not belong in it.
 *
 * "Two to four is the usual size" is where the requirement's "shu liang zi shi
 * ying" (adaptive count) actually lives. The ceiling is mechanical and enforced
 * elsewhere; the CHOICE is the model's, and this paragraph is the only thing
 * that informs it.
 */
export function buildTeamBlock(params: TeamBlockParams): string {
  const max = Math.max(1, Math.floor(params.maxSubagents));
  const concurrent = Math.max(1, Math.min(Math.floor(params.maxConcurrent), max));
  return [
    '<team_mode>',
    `You can delegate to parallel subagents with the task tool (up to ${max} per`,
    `call, ${concurrent} running at once).`,
    '',
    'Delegate when: the work splits into 2+ parts that do not need each other\'s',
    'output; several areas must be read or searched at once; a long build or test',
    'run can proceed while another part is investigated.',
    '',
    'Do not delegate when: one part needs another part\'s result (do those in order',
    'yourself); two parts would edit the same file; the whole job is a few edits.',
    'One well-scoped subagent is better than four vague ones. Two to four is the',
    'usual size; more than that is rarely faster.',
    '',
    'Each subagent starts with no memory of this conversation, so its prompt must',
    'carry everything it needs: the goal, the files or areas it owns, and what to',
    'report back. Give each one a disjoint set of files to write. Subagents cannot',
    'dispatch further subagents and cannot ask the user anything.',
    '',
    // THE TRAILING BLANK IS INSIDE THE CONDITIONAL, not outside it. An
    // unconditional `''` here would add a line to EVERY team-enabled prompt and
    // silently break the byte-identity `--no-fast` depends on (I-2).
    ...(params.fastDelegation
      ? [
          'A subagent doing mechanical, high-volume work can run on the cheaper fast',
          'model - see <fast_tier>.',
          '',
        ]
      : []),
    'You get one combined report when they all finish. Read it before deciding what',
    'to do next, and tell the user what the team found in your own words.',
    '</team_mode>',
  ].join('\n');
}

export interface SubagentBlockParams {
  label: string;
  description: string;
  /** Sibling labels, excluding this child's own. */
  peers: string[];
}

/**
 * The child's `<subagent_role>` block.
 *
 * "YOUR FINAL MESSAGE IS THE ONLY THING YOUR LEAD SEES" is load-bearing rather
 * than decorative: `SubagentRun.summary` is literally the last assistant text of
 * the child's history, so a child that signs off with "Let me know if you want
 * more detail!" produces a useless report entry and there is no mechanism that
 * can repair it after the fact. Wording is the only enforcement available, so it
 * is stated in imperative terms (R-12).
 */
export function buildSubagentBlock(params: SubagentBlockParams): string {
  const peers =
    params.peers.length > 0
      ? `Teammates: ${params.peers.join(', ')}. You cannot see their conversations and they cannot see yours.`
      : 'You are the only subagent on this task.';
  return [
    '<subagent_role>',
    `You are subagent "${params.label}" on a team. Your job: ${params.description}.`,
    peers,
    '',
    'Work only on your own task. Do not edit files another subagent owns. You cannot',
    'delegate further and there is no user to ask - if something is ambiguous, choose',
    'the most reasonable reading, proceed, and say what you assumed.',
    '',
    `To reach a teammate use team_send (at most ${TEAM_LIMITS.messagesPerAgent} messages, one every`,
    `${Math.round(TEAM_LIMITS.minSendIntervalMs / 1000)} seconds). Their replies arrive attached to your next tool result.`,
    'Use team_wait only when you genuinely cannot continue without an answer.',
    '',
    'END WITH YOUR REPORT. Your final message is the only thing your lead sees. It',
    'must state: what you did, what you found, every file you changed, and anything',
    'still open. Be concrete and brief - no preamble, no restating this brief.',
    '</subagent_role>',
  ].join('\n');
}
