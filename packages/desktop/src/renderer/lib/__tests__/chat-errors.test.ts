import { describe, expect, it } from 'vitest';
import { formatStreamError, initialViewState, viewReducer } from '@aragon-agent/tui/model/agent/reducer';
import { classifyErrorNotice, findRetryText } from '../chat-errors.js';

function llmError(message: string, errorType?: string): Error {
  return Object.assign(new Error(message), errorType ? { errorType } : {});
}

describe('actionable error notices', () => {
  it("matches the engine's own wording for every stable condition", () => {
    const cases: Array<[string, string]> = [
      [formatStreamError(llmError('boom', 'auth_error')), 'auth'],
      [formatStreamError(llmError('slow down', 'rate_limit')), 'rate-limit'],
      [formatStreamError(llmError('busy', 'overloaded')), 'rate-limit'],
      [formatStreamError(llmError('too long', 'context_overflow')), 'context-overflow'],
      ['No API key for "anthropic" - open /settings or set ANTHROPIC_API_KEY.', 'model-not-configured'],
      ['Provider "x" has no adapter. Choose one of anthropic, openai, or google (open /settings or set --provider).', 'model-not-configured'],
      ['MODEL_NOT_CONFIGURED', 'model-not-configured'],
      ['The run ended without producing a response - check your API key, model, and network.', 'no-response'],
    ];
    for (const [text, condition] of cases) expect(classifyErrorNotice(text)?.condition, text).toBe(condition);
  });

  it('offers model settings for missing configuration and compact for overflow', () => {
    expect(classifyErrorNotice('No API key for "openai" - open /settings')?.actions).toEqual(['open-models']);
    expect(classifyErrorNotice('Context length exceeded - try /compact')?.actions).toContain('compact-retry');
  });

  it('does not classify an unrelated error', () => {
    expect(classifyErrorNotice('ENOENT: no such file')).toBeNull();
  });

  it('puts a 429 on the retry path, not on model settings', () => {
    expect(classifyErrorNotice('HTTP 429 too many requests')?.actions).toEqual(['retry']);
  });
});

describe('findRetryText', () => {
  it('returns the last typed user message', () => {
    let state = viewReducer(initialViewState(), { type: 'submit', text: 'first' });
    state = viewReducer(state, { type: 'submit', text: 'second' });
    expect(findRetryText(state.entries)).toBe('second');
  });

  it("refuses an invocation entry: its text is the command line, not the prompt the model got", () => {
    const state = viewReducer(initialViewState(), {
      type: 'submit', text: '/skill do-it',
      invocation: { variant: 'skill', name: 'do-it', commandLine: '/skill do-it', input: '', inputHidden: 0, facts: [] },
    });
    expect(findRetryText(state.entries)).toBeNull();
  });

  it('is null for an empty transcript', () => {
    expect(findRetryText([])).toBeNull();
  });
});
