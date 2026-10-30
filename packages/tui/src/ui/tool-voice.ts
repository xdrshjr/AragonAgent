/**
 * The tool voice: the ONE exit from raw tool identifiers to human words
 * (tui-subagent-persona-and-developer-mode §3.2).
 *
 * TWO LAYERS, ONE SWITCH.
 *   layer 1 - `toolTitle` / `toolGerund`: stable, restrained names for the main
 *             transcript's tool cards, status bar and activity line. A title never
 *             changes with state (status is the badge's job), so it cannot jitter.
 *   layer 2 - `toolPhrase`: short playful phrases for a subagent's IN-PROGRESS row
 *             (`Hunting for retry policy`). Variant 0 is the shortest, most neutral
 *             wording and is what every RECORDING surface (timeline, settled card)
 *             uses - jokes belong to things that disappear, not to the record.
 *
 * THE SWITCH is `VoiceContext.mode`. In `'developer'` every function here returns
 * exactly what the code produced before this module existed (`describeToolActivity`
 * verbatim, the raw tool id), which makes developer mode both the regression
 * baseline and the rollback path. Pure functions take the voice as an OPTIONAL
 * trailing argument defaulting to `DEVELOPER_VOICE`, so every pre-existing caller
 * and test stays byte-identical; COMPONENTS take it as a required prop and never
 * through React context (the native scrollback replay renders in a second Ink
 * instance with no provider - a context would silently fall back to developer
 * words there).
 *
 * Variant choice is a function of `(label hash + tool call count)`, never of the
 * clock: it changes when a NEW tool call starts and holds while that call runs, so
 * it adds no timer and no per-frame flicker.
 *
 * ASCII ONLY: `src/ui/**` is inside `glyphs.test.ts`'s static scan.
 */

import {
  describeToolActivity,
  sanitizeActivity,
  type ActivityArgs,
} from '../model/team/activity.js';
import type { SubagentPhase, SubagentRun } from '../model/team/types.js';
import { ACTIVITY_PHRASES, pickActivityPhrase } from './activity-phrases.js';
import { hash32 } from './persona-names.js';

export type VoiceMode = 'friendly' | 'developer';

export interface VoiceContext {
  mode: VoiceMode;
  /** true -> every variant is 0 and the thinking word does not rotate. */
  reducedMotion: boolean;
  /** label -> persona name. Empty string when unknown. */
  nameOf: (label: string) => string;
  /**
   * `(scope, label)` -> persona name, for surfaces that draw a DIFFERENT scope than
   * the live panel (a settled dispatch card names its children by its own dispatch id).
   * Optional: a voice without it resolves everything through `nameOf`.
   */
  nameIn?: (scope: string, label: string) => string;
}

/** The pure functions' default: today's wording, no persona names. */
export const DEVELOPER_VOICE: VoiceContext = {
  mode: 'developer',
  reducedMotion: false,
  nameOf: () => '',
};

/**
 * The same voice with `nameOf` bound to `scope`. Lets a card draw the names its
 * dispatch was given (the book aliases governance stage dispatches to their run).
 */
export function bindVoiceScope(voice: VoiceContext, scope: string): VoiceContext {
  const nameIn = voice.nameIn;
  if (nameIn === undefined) return voice;
  return { ...voice, nameOf: (label) => nameIn(scope, label) };
}

/** Longest humanized name (an unregistered tool), and the Unicode ellipsis stand-in. */
const HUMANIZE_MAX_CHARS = 24;
/** A variant is only used when it leaves at least this many cells for its detail. */
const VARIANT_DETAIL_SLACK = 4;
const VARIANT_COUNT = 3;

/** Table A: static title (main card header) and gerund (status bar / activity line). */
const TOOL_NAMES: Readonly<Record<string, { title: string; gerund: string }>> = {
  read_file: { title: 'Read file', gerund: 'Reading file' },
  write_file: { title: 'Write file', gerund: 'Writing file' },
  edit_file: { title: 'Edit file', gerund: 'Editing file' },
  list_dir: { title: 'List folder', gerund: 'Browsing folder' },
  glob: { title: 'Find files', gerund: 'Finding files' },
  grep: { title: 'Search text', gerund: 'Searching text' },
  bash: { title: 'Run command', gerund: 'Running command' },
  bash_output: { title: 'Check output', gerund: 'Checking output' },
  bash_kill: { title: 'Stop command', gerund: 'Stopping command' },
  job_list: { title: 'List jobs', gerund: 'Listing jobs' },
  job_wait: { title: 'Wait for job', gerund: 'Waiting for job' },
  task: { title: 'Delegate', gerund: 'Delegating' },
  ask_user: { title: 'Ask you', gerund: 'Asking you' },
  submit_plan: { title: 'Submit plan', gerund: 'Submitting plan' },
  todo_write: { title: 'Update todos', gerund: 'Updating todos' },
  skill_create: { title: 'Create skill', gerund: 'Creating skill' },
  skill_install: { title: 'Install skill', gerund: 'Installing skill' },
  team_send: { title: 'Message teammate', gerund: 'Messaging teammate' },
  team_wait: { title: 'Wait for mail', gerund: 'Waiting for mail' },
  gov_dispatch: { title: 'Dispatch stage', gerund: 'Dispatching stage' },
  gov_run: { title: 'Run governance', gerund: 'Running governance' },
  gov_scan: { title: 'Scan project', gerund: 'Scanning project' },
  gov_read: { title: 'Read case file', gerund: 'Reading case file' },
  gov_view: { title: 'View record', gerund: 'Viewing record' },
  gov_submit_work: { title: 'Submit work', gerund: 'Submitting work' },
  gov_submit_review: { title: 'Submit review', gerund: 'Submitting review' },
  gov_submit_test: { title: 'Submit test', gerund: 'Submitting test' },
  ledger_apply: { title: 'Score agent', gerund: 'Scoring agent' },
  ledger_rule: { title: 'Rule on appeal', gerund: 'Ruling on appeal' },
  ledger_settle: { title: 'Settle scores', gerund: 'Settling scores' },
  ledger_standings: { title: 'Check standings', gerund: 'Checking standings' },
};

type Variants = readonly [string, string, string];

/** Table B: in-progress phrases. Variant 0 = shortest / most neutral. */
const TOOL_PHRASES: Readonly<Record<string, { variants: Variants; noun: string }>> = {
  read_file: { variants: ['Reading', 'Skimming', 'Studying'], noun: 'a file' },
  write_file: { variants: ['Writing', 'Drafting', 'Laying down'], noun: 'a file' },
  edit_file: { variants: ['Editing', 'Tweaking', 'Polishing'], noun: 'a file' },
  list_dir: { variants: ['Browsing', 'Scouting', 'Wandering through'], noun: 'a folder' },
  glob: { variants: ['Finding', 'Rounding up', 'Casting a net for'], noun: 'files' },
  grep: { variants: ['Searching for', 'Hunting for', 'Tracking down'], noun: 'the code' },
  bash: { variants: ['Running', 'Firing up', 'Spinning up'], noun: 'a command' },
  team_send: { variants: ['Messaging', 'Passing a note to', 'Pinging'], noun: 'a teammate' },
  team_wait: {
    variants: ['Waiting for', 'Listening for', 'Waiting to hear from'],
    noun: 'mail',
  },
};

function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/** Tool names that have a title and gerund. Exported so a translated table can be parity-tested. */
export const KNOWN_VOICE_TOOLS: readonly string[] = Object.keys(TOOL_NAMES);
/** Tool names that have 3 phrase variants. */
export const PHRASE_VOICE_TOOLS: readonly string[] = Object.keys(TOOL_PHRASES);

/** Number of thinking words, for translation parity checks. */
export const THINKING_WORD_COUNT: number = ACTIVITY_PHRASES.length;

/**
 * An unregistered tool's name as words: `skill_find` -> `Skill find`.
 *
 * The name comes from the model or an MCP server, so it is UNTRUSTED: the output
 * is forced through `sanitizeActivity` (control characters, escape sequences,
 * length) like every other model-controlled string that reaches a cell.
 */
export function humanize(tool: string): string {
  const words = sanitizeActivity(tool.replace(/[_\-.:]+/g, ' '), HUMANIZE_MAX_CHARS);
  return words.length === 0 ? 'Tool' : capitalize(words);
}

/** Static, state-independent title. Developer mode returns the raw identifier. */
export function toolTitle(tool: string, mode: VoiceMode): string {
  if (mode === 'developer') return tool;
  return TOOL_NAMES[tool]?.title ?? humanize(tool);
}

/** Present-progressive form for the status bar / activity line. */
export function toolGerund(tool: string, mode: VoiceMode): string {
  if (mode === 'developer') return tool;
  return TOOL_NAMES[tool]?.gerund ?? `Running ${humanize(tool)}`;
}

export interface PhraseInput {
  tool: string;
  args?: ActivityArgs;
  /** Terminal wide enough for whole paths / command lines. */
  wide: boolean;
  /** `hash32(label) + toolCalls`: advances with each new tool call, not with time. */
  variantSeed: number;
  /** Characters available; a variant that would crowd its detail falls back to 0. */
  budget: number;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function program(commandLine: string): string {
  const first = commandLine.trim().split(/\s+/)[0] ?? '';
  return basename(first) || commandLine;
}

/** What the tool is acting ON, in the same wide/narrow terms `describeToolActivity` uses. */
function objectOf(
  tool: string,
  args: ActivityArgs,
  wide: boolean,
  voice: VoiceContext,
): string {
  const pick = (value: string | undefined, narrow: (v: string) => string): string => {
    const v = (value ?? '').trim();
    return v.length === 0 ? '' : wide ? v : narrow(v);
  };
  switch (tool) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return pick(args.path, basename);
    case 'list_dir':
      return pick(args.path ?? '.', basename);
    case 'glob':
    case 'grep':
      return pick(args.pattern, basename);
    case 'bash':
      return pick(args.command, program);
    case 'team_send':
    case 'team_wait': {
      const who = ((tool === 'team_send' ? args.to : args.from) ?? '').trim();
      if (who.length === 0) return '';
      if (who === 'lead') return 'the lead';
      const name = voice.nameOf(who);
      return name.length > 0 ? name : who;
    }
    default:
      return '';
  }
}

/**
 * The in-progress phrase for one tool call.
 *
 * Developer voice returns `describeToolActivity` UNCHANGED (the caller clamps it,
 * exactly as before). Friendly voice picks a variant, appends the object, and
 * clamps - the object is model-controlled, so the result always crosses
 * `sanitizeActivity`.
 */
export function toolPhrase(input: PhraseInput, voice: VoiceContext): string {
  const { tool, args, wide, variantSeed, budget } = input;
  if (voice.mode === 'developer') return describeToolActivity(tool, args, wide);
  const entry = TOOL_PHRASES[tool];
  if (entry === undefined) return sanitizeActivity(toolGerund(tool, 'friendly'), budget);
  const object = objectOf(tool, args ?? {}, wide, voice);
  let variant = voice.reducedMotion ? 0 : ((variantSeed % VARIANT_COUNT) + VARIANT_COUNT) % VARIANT_COUNT;
  if (entry.variants[variant]!.length + VARIANT_DETAIL_SLACK > budget) variant = 0;
  return sanitizeActivity(`${entry.variants[variant]!} ${object || entry.noun}`, budget);
}

/** The facts a friendly activity line is built from (a run, or a governance roster row). */
export interface ActivityView {
  phase: SubagentPhase;
  retries?: number;
  /** The tool in flight; only meaningful for `tool` / `waiting`. */
  tool?: string;
  args?: ActivityArgs;
  /** Prose the child is writing, WITHOUT any `lastTool` fallback. */
  text?: string;
  /** Tool-call count: the variant seed, shared by every surface. */
  calls: number;
  startedAt?: number;
}

export interface ActivityFrame {
  /** Seeds the variant and the thinking word so rows do not change in lockstep. */
  seed: string;
  budget: number;
  wide: boolean;
  at: number;
  /** `glyphs.ellipsis` - never a hand-typed `...` (glyph scanner). */
  ellipsis: string;
}

/**
 * The friendly sentence for a NON-TERMINAL phase. `done` / `failed` / `aborted` are
 * not handled here on purpose: terminal states and errors stay plain (D-7), and the
 * caller owns them in both modes.
 */
export function friendlyActivity(
  view: ActivityView,
  frame: ActivityFrame,
  voice: VoiceContext,
): string {
  const variantSeed = hash32(frame.seed) + view.calls;
  const phrase = (tool: string): string =>
    toolPhrase({ tool, args: view.args, wide: frame.wide, variantSeed, budget: frame.budget }, voice);
  switch (view.phase) {
    case 'queued':
      return 'Waiting for a slot';
    case 'starting':
      return view.retries ? 'Trying again' : 'Warming up';
    case 'thinking':
      return view.text
        ? `writing: ${sanitizeActivity(view.text, frame.budget)}`
        : `${pickActivityPhrase(view.startedAt ?? 0, frame.at, !voice.reducedMotion, hash32(frame.seed))}${frame.ellipsis}`;
    case 'tool':
      return view.tool ? phrase(view.tool) : 'Working';
    case 'waiting':
      return view.tool === 'team_wait' ? phrase(view.tool) : 'Waiting for a reply';
    default:
      return '';
  }
}

/** `friendlyActivity` over a live run. Developer voice is the caller's legacy path. */
export function teamPhaseText(
  run: SubagentRun,
  frame: Omit<ActivityFrame, 'seed'>,
  voice: VoiceContext,
): string {
  return friendlyActivity(
    {
      phase: run.phase,
      retries: run.retries,
      tool: run.lastTool,
      args: run.activityArgs,
      text: run.activity,
      calls: run.toolCalls,
      startedAt: run.startedAt,
    },
    { ...frame, seed: run.label },
    voice,
  );
}
