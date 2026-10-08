/**
 * One-shot connection test: run a single-turn `aragon exec` with the profile's
 * environment and report whether the provider answered.
 *
 * This is the only honest test - `aragon info` reports build capabilities, not
 * credentials. A turn with `--max-turns 1` and a trivial prompt exercises the
 * full auth -> model -> stream path with the same env the real session gets.
 */

import { randomUUID } from 'node:crypto';
import type { ExecEvent } from '../../shared/exec-events.js';
import type { ProfileDraftInput, TestOutcome, TestProgressStep } from '../../shared/protocol.js';
import { CHANNELS } from '../../shared/protocol.js';
import { ExecChild } from '../agent/spawn.js';
import type { SettingsStore } from './store.js';
import { buildProfileEnv } from './env-inject.js';
import { normalizeDraft } from './profiles.js';

const TEST_TIMEOUT_MS = 45000;
const TEST_PROMPT = 'Reply with exactly: OK';

export interface TestDeps {
  settings: SettingsStore;
  launcherPath: () => string;
  execPath: string;
  send: (channel: string, ...args: unknown[]) => void;
}

export async function runProfileTest(
  deps: TestDeps,
  draft: ProfileDraftInput,
): Promise<TestOutcome> {
  const normalized = normalizeDraft(draft);
  const profileId = draft.id ?? null;
  const storedKey = profileId ? deps.settings.decryptKey(profileId) : null;
  const apiKey = normalized.apiKey ?? storedKey;
  const envOverrides = buildProfileEnv({
    mode: normalized.mode,
    model: normalized.model,
    baseUrl: normalized.baseUrl,
    thinking: 'off',
    apiKey,
  });

  const testId = `desktop-test-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const progress = (step: TestProgressStep) => deps.send(CHANNELS.testProgress, testId, step);

  return new Promise<TestOutcome>((resolve) => {
    let settled = false;
    let sawModelActivity = false;
    const finish = (outcome: TestOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.requestEnd();
      setTimeout(() => child.kill(), 1500);
      resolve(outcome);
    };

    const child = new ExecChild({
      launcherPath: deps.launcherPath(),
      args: [
        'exec',
        '--output-format',
        'stream-json',
        '--no-save-session',
        '--max-turns',
        '1',
        TEST_PROMPT,
      ],
      cwd: process.env.USERPROFILE ?? process.env.HOME ?? '.',
      envOverrides,
      execPath: deps.execPath,
      onEvent: (event: ExecEvent) => handleEvent(event),
      onStderrLine: () => undefined,
      onExit: () => {
        if (!settled) {
          finish({
            kind: 'failed',
            message: sawModelActivity
              ? 'The connection closed before the model replied.'
              : 'The agent process exited before reaching the provider. Check the model id and base URL.',
          });
        }
      },
    });

    const timer = setTimeout(() => {
      finish({ kind: 'failed', message: `Timed out after ${TEST_TIMEOUT_MS / 1000}s.` });
    }, TEST_TIMEOUT_MS);

    function handleEvent(event: ExecEvent): void {
      if (event.type === 'error' && event.fatal) {
        finish({ kind: 'failed', message: event.message, code: event.code });
        return;
      }
      if (event.type === 'text_delta' || event.type === 'assistant') {
        sawModelActivity = true;
        progress({ phase: 'model' });
      }
      if (event.type === 'result') {
        if (event.isError) {
          finish({
            kind: 'failed',
            message: event.error?.message ?? 'The provider rejected the request.',
            code: event.error?.code,
          });
          return;
        }
        progress({ phase: 'done', detail: event.model.id });
        finish({
          kind: 'ok',
          model: event.model.id,
          provider: event.model.provider,
          durationMs: Date.now() - startedAt,
        });
      }
    }

    progress({ phase: 'starting' });
    child.start();
  });
}
