/**
 * `resolveExecOptions` (cli-integration-surface section 4.1 / AC-19).
 *
 * EVERY BRANCH IS A USAGE ERROR OR IT IS NOT, and the difference is the whole
 * contract: exit 2 means the run never started and stdout carries nothing, so a
 * validation that silently accepted a typo would be indistinguishable from a
 * model that chose not to use a tool.
 */

import { describe, expect, it } from 'vitest';
import { resolveExecOptions, type RawExecOptions } from '../exec/options.js';
import { HOST_TOOL_NAMES } from '../tools/index.js';

function ok(raw: RawExecOptions): ReturnType<typeof resolveExecOptions> & { ok: true } {
  const result = resolveExecOptions(raw);
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result;
}

function fail(raw: RawExecOptions): { code: string; message: string } {
  const result = resolveExecOptions(raw);
  if (result.ok) throw new Error('expected a usage error');
  return { code: result.code, message: result.message };
}

describe('defaults', () => {
  it('is text/text with no session flags and saving on', () => {
    const { options } = ok({});
    expect(options.outputFormat).toBe('text');
    expect(options.inputFormat).toBe('text');
    expect(options.permissionMode).toBe('auto');
    expect(options.saveSession).toBe(true);
    expect(options.continueSession).toBe(false);
    expect(options.maxTurns).toBeUndefined();
    expect(options.maxDurationMs).toBeUndefined();
    expect(options.warnings).toEqual([]);
  });

  it('honours --no-save-session, which commander spells as `false`', () => {
    expect(ok({ saveSession: false }).options.saveSession).toBe(false);
    // Commander materializes `true` when the negative form is absent, which must
    // stay indistinguishable from silence.
    expect(ok({ saveSession: true }).options.saveSession).toBe(true);
  });
});

describe('formats', () => {
  it('rejects an unknown --output-format and names the valid set', () => {
    const { code, message } = fail({ outputFormat: 'ndjson' });
    expect(code).toBe('invalid_output_format');
    expect(message).toContain('stream-json');
  });

  it('rejects an unknown --input-format', () => {
    expect(fail({ inputFormat: 'yaml', outputFormat: 'stream-json' }).code).toBe(
      'invalid_input_format',
    );
  });

  it('AC-19: --input-format stream-json without --output-format stream-json exits 2', () => {
    expect(fail({ inputFormat: 'stream-json' }).code).toBe(
      'input_format_requires_stream_json',
    );
    expect(fail({ inputFormat: 'stream-json', outputFormat: 'json' }).code).toBe(
      'input_format_requires_stream_json',
    );
    expect(ok({ inputFormat: 'stream-json', outputFormat: 'stream-json' }).options.inputFormat).toBe(
      'stream-json',
    );
  });

  it('keeps the stream-only flags out of json mode', () => {
    expect(fail({ outputFormat: 'json', partialMessages: true }).code).toBe('stream_only_flag');
    expect(fail({ outputFormat: 'json', includeThinking: true }).code).toBe('stream_only_flag');
  });
});

describe('AC-19: text mode refuses what `runHeadless` cannot observe', () => {
  // D-1: text delegates to `runHeadless` VERBATIM, so anything that would need
  // to interrupt or watch that stream is refused rather than silently ignored.
  const cases: [string, RawExecOptions][] = [
    ['--max-turns', { maxTurns: '3' }],
    ['--max-duration', { maxDuration: '5000' }],
    ['--timeout alias', { timeout: '5000' }],
    ['--partial-messages', { partialMessages: true }],
    ['--include-thinking', { includeThinking: true }],
  ];
  for (const [label, raw] of cases) {
    it(`refuses ${label} and names the format`, () => {
      const { code, message } = fail(raw);
      expect(code).toBe('unsupported_in_text_mode');
      expect(message).toContain('--output-format text');
    });
  }

  it('still supports the permission and session flags in text mode', () => {
    const { options } = ok({
      permissionMode: 'strict',
      allowTool: ['read_file'],
      sessionId: 'ci-1',
      appendSystemPrompt: 'be terse',
    });
    expect(options.outputFormat).toBe('text');
    expect(options.sessionId).toBe('ci-1');
    expect(options.allowTools).toEqual(['read_file']);
  });
});

describe('AC-19: `exec --print` is refused', () => {
  it('names the alternative rather than ignoring the flag', () => {
    const { code, message } = fail({ print: true });
    expect(code).toBe('print_not_supported');
    expect(message).toContain('--output-format text');
  });
});

describe('budgets', () => {
  it('accepts --max-turns >= 1 and rejects everything else', () => {
    expect(ok({ outputFormat: 'json', maxTurns: '1' }).options.maxTurns).toBe(1);
    expect(fail({ outputFormat: 'json', maxTurns: '0' }).code).toBe('invalid_max_turns');
    expect(fail({ outputFormat: 'json', maxTurns: '-2' }).code).toBe('invalid_max_turns');
    expect(fail({ outputFormat: 'json', maxTurns: 'many' }).code).toBe('invalid_max_turns');
  });

  it('accepts --max-duration >= 1000 and rejects everything else', () => {
    expect(ok({ outputFormat: 'json', maxDuration: '1000' }).options.maxDurationMs).toBe(1000);
    expect(fail({ outputFormat: 'json', maxDuration: '999' }).code).toBe('invalid_max_duration');
    expect(fail({ outputFormat: 'json', maxDuration: '1s' }).code).toBe('invalid_max_duration');
  });

  it('AC-17: the hidden --timeout alias resolves to the same option', () => {
    expect(ok({ outputFormat: 'json', timeout: '2500' }).options.maxDurationMs).toBe(2500);
    // `--max-duration` wins when both are passed: the alias exists so a guess is
    // not punished, not so it can disagree with the documented name.
    expect(
      ok({ outputFormat: 'json', maxDuration: '4000', timeout: '2500' }).options.maxDurationMs,
    ).toBe(4000);
  });
});

describe('AC-8 / AC-14: identity and tool names', () => {
  it('refuses a traversal id, an empty id, a dotted id and an over-long id', () => {
    for (const id of ['../../etc/passwd', '', '.hidden', 'a/b', 'a\\b', 'x'.repeat(65)]) {
      expect(fail({ sessionId: id }).code).toBe('invalid_session_id');
    }
  });

  it('accepts an ordinary id', () => {
    expect(ok({ sessionId: 'ci-42.run_7' }).options.sessionId).toBe('ci-42.run_7');
    expect(ok({ sessionId: 'x'.repeat(64) }).options.sessionId).toHaveLength(64);
  });

  it('refuses two session flags at once', () => {
    expect(fail({ sessionId: 'a', resume: 'b' }).code).toBe('session_flag_conflict');
    expect(fail({ continue: true, resume: 'b' }).code).toBe('session_flag_conflict');
  });

  it('AC-14: an unknown tool name exits 2 and names the valid set', () => {
    const { code, message } = fail({ allowTool: ['nosuchtool'] });
    expect(code).toBe('unknown_tool');
    for (const name of HOST_TOOL_NAMES) expect(message).toContain(name);
  });

  it('splits comma lists and accepts repetition, without duplicating', () => {
    const { options } = ok({ allowTool: ['read_file,grep', 'glob'], denyTool: ['bash', 'bash'] });
    expect(options.allowTools).toEqual(['read_file', 'grep', 'glob']);
    expect(options.denyTools).toEqual(['bash']);
  });
});

describe('P2-2: a name that is real but never registered headlessly', () => {
  it('accepts --allow-tool ask_user and warns instead of failing', () => {
    // `HOST_TOOL_NAMES` answers "can this declaration ever take effect?", and
    // for `ask_user` the answer is yes - just not in a headless run. Rejecting
    // it would be wrong; accepting it silently would be worse.
    const { options } = ok({ allowTool: ['ask_user'] });
    expect(options.allowTools).toEqual(['ask_user']);
    expect(options.warnings).toHaveLength(1);
    expect(options.warnings[0]).toContain('ask_user');
    expect(options.warnings[0]).toContain('no effect');
  });
});
