/**
 * `aragon exec` option resolution (cli-integration-surface section 4.1).
 *
 * ASCII ONLY - `src/exec/**` is inside the glyph scanner's scope.
 *
 * PURE. Every branch here is a decision about the FLAGS, never about the world:
 * no file is read, no session is resolved, no stdin is consumed. Prompt
 * resolution and file reads live in `exec/index.ts`, which is the module allowed
 * to touch the process.
 *
 * A USAGE ERROR IS EXIT 2 AND NOTHING ON STDOUT. That is the whole reason this
 * module returns a discriminated union instead of throwing: `--output-format
 * json` promises exactly one JSON object on stdout, and a stack trace or a
 * half-written event would corrupt every consumer. The caller writes the message
 * to stderr and exits.
 */

import { HOST_TOOL_NAMES } from '../tools/index.js';
import { isValidSessionId } from '../session/store.js';
import type { ExecInputFormat, ExecOutputFormat, ExecPermissionMode } from './events.js';

/** Raw commander output. Every field is whatever the user typed, or absent. */
export interface RawExecOptions {
  outputFormat?: string;
  inputFormat?: string;
  partialMessages?: boolean;
  includeThinking?: boolean;
  promptFile?: string;
  sessionId?: string;
  resume?: string;
  continue?: boolean;
  /** `--no-save-session` => `false`; absent => `undefined`. */
  saveSession?: boolean;
  maxTurns?: string;
  maxDuration?: string;
  /** The hidden `--timeout` alias of `--max-duration` (P2-1 / D-16). */
  timeout?: string;
  permissionMode?: string;
  allowTool?: string[];
  denyTool?: string[];
  appendSystemPrompt?: string;
  appendSystemPromptFile?: string;
  /** The ROOT `-p/--print`, hoisted by commander. Refused (P2-5). */
  print?: boolean;
  quiet?: boolean;
}

export interface ExecOptions {
  outputFormat: ExecOutputFormat;
  inputFormat: ExecInputFormat;
  partialMessages: boolean;
  includeThinking: boolean;
  promptFile?: string;
  sessionId?: string;
  resume?: string;
  continueSession: boolean;
  saveSession: boolean;
  maxTurns?: number;
  maxDurationMs?: number;
  permissionMode: ExecPermissionMode;
  allowTools: string[];
  denyTools: string[];
  appendSystemPrompt?: string;
  appendSystemPromptFile?: string;
  quiet: boolean;
  /**
   * Non-fatal notes for stderr. Empty on every well-formed invocation, so a
   * caller can treat a non-empty list as "you asked for something inert".
   */
  warnings: string[];
}

export type ExecUsageCode =
  | 'invalid_output_format'
  | 'invalid_input_format'
  | 'invalid_permission_mode'
  | 'invalid_max_turns'
  | 'invalid_max_duration'
  | 'invalid_session_id'
  | 'unknown_tool'
  | 'unsupported_in_text_mode'
  | 'input_format_requires_stream_json'
  | 'stream_only_flag'
  | 'session_flag_conflict'
  | 'print_not_supported';

export type ExecOptionsResult =
  | { ok: true; options: ExecOptions }
  | { ok: false; code: ExecUsageCode; message: string };

const OUTPUT_FORMATS: readonly string[] = ['text', 'json', 'stream-json'];
const INPUT_FORMATS: readonly string[] = ['text', 'stream-json'];
const PERMISSION_MODES: readonly string[] = ['auto', 'plan', 'strict'];

/**
 * Registered nowhere in a headless session, yet real names (P2-2).
 *
 * `planTools` is empty under `exec`, so `--allow-tool ask_user` validates and
 * then does nothing. REJECTING IT WOULD BE WRONG - `HOST_TOOL_NAMES` answers
 * "can this declaration ever take effect?", and the answer for these two is yes,
 * just not here - so exec accepts it and says one line on stderr.
 */
const NEVER_REGISTERED_HEADLESS: readonly string[] = ['ask_user', 'submit_plan'];

/**
 * Flags that need to observe or interrupt the stream `runHeadless` owns, and are
 * therefore REFUSED under `--output-format text` (D-1).
 *
 * The refusal is explicit and names both the flag and the format, never a silent
 * no-op: text mode delegates to `runHeadless` VERBATIM, which is what makes
 * "the human CLI is unchanged" a fact anyone can check rather than an argument
 * someone has to trust. Session flags are absent from this list on purpose -
 * save and resume happen OUTSIDE the run, so they work in every format.
 */
const TEXT_MODE_REFUSED: readonly { flag: string; test: (o: RawExecOptions) => boolean }[] = [
  { flag: '--max-turns', test: (o) => o.maxTurns !== undefined },
  {
    flag: '--max-duration',
    test: (o) => o.maxDuration !== undefined || o.timeout !== undefined,
  },
  { flag: '--input-format stream-json', test: (o) => o.inputFormat === 'stream-json' },
  { flag: '--partial-messages', test: (o) => o.partialMessages === true },
  { flag: '--include-thinking', test: (o) => o.includeThinking === true },
];

function usage(code: ExecUsageCode, message: string): ExecOptionsResult {
  return { ok: false, code, message };
}

/** Accept both `--allow-tool a --allow-tool b` and `--allow-tool a,b`. */
function splitNames(values: string[] | undefined): string[] {
  if (!values) return [];
  const out: string[] = [];
  for (const value of values) {
    for (const part of value.split(',')) {
      const name = part.trim();
      if (name.length > 0 && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(n) ? n : null;
}

export function resolveExecOptions(raw: RawExecOptions): ExecOptionsResult {
  if (raw.print) {
    return usage(
      'print_not_supported',
      '`aragon exec` is already the headless face; `-p/--print` is not accepted here. ' +
        'Use `aragon exec --output-format text` for the same stdout as `aragon -p`.',
    );
  }

  const outputFormat = (raw.outputFormat ?? 'text').trim();
  if (!OUTPUT_FORMATS.includes(outputFormat)) {
    return usage(
      'invalid_output_format',
      `Unknown --output-format "${outputFormat}". Choose: ${OUTPUT_FORMATS.join(', ')}.`,
    );
  }
  const inputFormat = (raw.inputFormat ?? 'text').trim();
  if (!INPUT_FORMATS.includes(inputFormat)) {
    return usage(
      'invalid_input_format',
      `Unknown --input-format "${inputFormat}". Choose: ${INPUT_FORMATS.join(', ')}.`,
    );
  }
  if (inputFormat === 'stream-json' && outputFormat !== 'stream-json') {
    return usage(
      'input_format_requires_stream_json',
      '--input-format stream-json requires --output-format stream-json.',
    );
  }

  const formatError = checkFormatCompatibility(raw, outputFormat);
  if (formatError) return formatError;

  const permissionMode = (raw.permissionMode ?? 'auto').trim();
  if (!PERMISSION_MODES.includes(permissionMode)) {
    return usage(
      'invalid_permission_mode',
      `Unknown --permission-mode "${permissionMode}". Choose: ${PERMISSION_MODES.join(', ')}.`,
    );
  }

  const budgets = resolveBudgets(raw);
  if (!budgets.ok) return budgets.error;

  const sessionError = checkSessionFlags(raw);
  if (sessionError) return sessionError;

  const allowTools = splitNames(raw.allowTool);
  const denyTools = splitNames(raw.denyTool);
  const toolError = checkToolNames([...allowTools, ...denyTools]);
  if (toolError) return toolError;

  const warnings: string[] = [];
  for (const name of allowTools) {
    if (NEVER_REGISTERED_HEADLESS.includes(name)) {
      warnings.push(
        `--allow-tool ${name}: that tool is never registered in a headless run, so allowing it has no effect.`,
      );
    }
  }

  return {
    ok: true,
    options: {
      outputFormat: outputFormat as ExecOutputFormat,
      inputFormat: inputFormat as ExecInputFormat,
      partialMessages: raw.partialMessages === true,
      includeThinking: raw.includeThinking === true,
      ...(raw.promptFile ? { promptFile: raw.promptFile } : {}),
      ...(raw.sessionId ? { sessionId: raw.sessionId.trim() } : {}),
      ...(raw.resume ? { resume: raw.resume.trim() } : {}),
      continueSession: raw.continue === true,
      // `--no-save-session` is the only way this becomes `false`; commander
      // leaves it `undefined` when the flag is absent.
      saveSession: raw.saveSession !== false,
      ...(budgets.maxTurns !== undefined ? { maxTurns: budgets.maxTurns } : {}),
      ...(budgets.maxDurationMs !== undefined ? { maxDurationMs: budgets.maxDurationMs } : {}),
      permissionMode: permissionMode as ExecPermissionMode,
      allowTools,
      denyTools,
      ...(raw.appendSystemPrompt ? { appendSystemPrompt: raw.appendSystemPrompt } : {}),
      ...(raw.appendSystemPromptFile
        ? { appendSystemPromptFile: raw.appendSystemPromptFile }
        : {}),
      quiet: raw.quiet === true,
      warnings,
    },
  };
}

/** Split out so `resolveExecOptions` stays under this package's size ceiling. */
function checkFormatCompatibility(
  raw: RawExecOptions,
  outputFormat: string,
): ExecOptionsResult | null {
  if (outputFormat === 'text') {
    for (const { flag, test } of TEXT_MODE_REFUSED) {
      if (!test(raw)) continue;
      return usage(
        'unsupported_in_text_mode',
        `${flag} is not supported with --output-format text (text mode delegates to the ` +
          'same renderer as `aragon -p`). Use --output-format json or stream-json.',
      );
    }
    return null;
  }
  if (outputFormat === 'json') {
    if (raw.partialMessages === true) {
      return usage(
        'stream_only_flag',
        '--partial-messages requires --output-format stream-json.',
      );
    }
    if (raw.includeThinking === true) {
      return usage(
        'stream_only_flag',
        '--include-thinking requires --output-format stream-json.',
      );
    }
  }
  return null;
}

type BudgetResolution =
  | { ok: true; maxTurns?: number; maxDurationMs?: number }
  | { ok: false; error: ExecOptionsResult };

function resolveBudgets(raw: RawExecOptions): BudgetResolution {
  let maxTurns: number | undefined;
  if (raw.maxTurns !== undefined) {
    const parsed = parsePositiveInt(raw.maxTurns);
    if (parsed === null || parsed < 1) {
      return { ok: false, error: usage('invalid_max_turns', '--max-turns must be an integer >= 1.') };
    }
    maxTurns = parsed;
  }
  let maxDurationMs: number | undefined;
  // `--max-duration` wins over the hidden `--timeout` alias when a caller passes
  // both; the alias exists so a guess is not punished, not so it can disagree.
  const durationRaw = raw.maxDuration ?? raw.timeout;
  if (durationRaw !== undefined) {
    const parsed = parsePositiveInt(durationRaw);
    if (parsed === null || parsed < 1000) {
      return {
        ok: false,
        error: usage(
          'invalid_max_duration',
          '--max-duration must be an integer >= 1000 (milliseconds).',
        ),
      };
    }
    maxDurationMs = parsed;
  }
  return {
    ok: true,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
  };
}

function checkSessionFlags(raw: RawExecOptions): ExecOptionsResult | null {
  if (raw.sessionId !== undefined) {
    const id = raw.sessionId.trim();
    if (!isValidSessionId(id)) {
      return usage(
        'invalid_session_id',
        `Invalid --session-id "${raw.sessionId}". Use 1-64 characters matching ` +
          '[A-Za-z0-9][A-Za-z0-9._-]* (no "/", "\\", ".." or a leading dot).',
      );
    }
  }
  const chosen = [
    raw.sessionId !== undefined ? '--session-id' : null,
    raw.resume !== undefined ? '--resume' : null,
    raw.continue === true ? '--continue' : null,
  ].filter((flag): flag is string => flag !== null);
  if (chosen.length > 1) {
    return usage(
      'session_flag_conflict',
      `Pass only one of ${chosen.join(', ')}: they are three different answers to ` +
        '"which session is this".',
    );
  }
  return null;
}

function checkToolNames(names: string[]): ExecOptionsResult | null {
  const known = new Set<string>(HOST_TOOL_NAMES);
  for (const name of names) {
    if (known.has(name)) continue;
    // A typo that silently allows nothing is exactly the failure this feature
    // exists to prevent, so the valid set is printed rather than hinted at.
    return usage(
      'unknown_tool',
      `Unknown tool "${name}". Valid names: ${[...HOST_TOOL_NAMES].join(', ')}.`,
    );
  }
  return null;
}
