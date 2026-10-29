/**
 * Per-test plumbing shared by every scenario: launch, collect failure artifacts, and enforce the
 * three rules that make an E2E run mean something.
 *
 *   - NO UNEXPLAINED RENDERER ERRORS (AC-43): a `pageerror` or `console.error` not on the
 *     allow-list fails the test, so a white screen is not hidden by an element that still exists.
 *   - NO LEFTOVER SCRIPT (AC-45): every scripted model turn must have been requested. "The engine
 *     asked one time fewer than the scenario assumed" is a behavior change, not a pass.
 *   - ARTIFACTS ON FAILURE (AC-44): screenshot, renderer log, what the model was sent and the tail
 *     of the main-process log land in `test-results/<case>/`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { launchApp, type LaunchOptions, type Launched } from './launch.js';

const resultsRoot = join(process.cwd(), 'test-results');

const live: Launched[] = [];
const names = new WeakMap<Launched, string>();

export interface HarnessOptions extends LaunchOptions {
  /** Skip the "no turn left unconsumed" check (for tests that stop a run on purpose). */
  allowUnconsumed?: boolean;
}

export async function start(name: string, options: HarnessOptions = {}): Promise<Launched> {
  const app = await launchApp(options);
  names.set(app, name);
  live.push(app);
  (app as Launched & { allowUnconsumed?: boolean }).allowUnconsumed = options.allowUnconsumed === true;
  return app;
}

function tail(path: string, bytes = 6000): string {
  try {
    const text = readFileSync(path, 'utf8');
    return text.slice(Math.max(0, text.length - bytes));
  } catch {
    return '(no file)';
  }
}

async function saveArtifacts(app: Launched, name: string): Promise<void> {
  const dir = join(resultsRoot, name.replace(/[^A-Za-z0-9._-]+/g, '_'));
  mkdirSync(dir, { recursive: true });
  await app.window.screenshot({ path: join(dir, 'window.png') }).catch(() => undefined);
  writeFileSync(join(dir, 'renderer.log'), app.logs.join('\n'));
  writeFileSync(join(dir, 'model-requests.json'), JSON.stringify(app.mock.requests(), null, 2));
  writeFileSync(join(dir, 'main-log-tail.txt'), tail(join(app.home, 'logs', 'desktop.log')));
}

afterEach(async (context) => {
  const apps = live.splice(0);
  for (const app of apps) {
    const name = names.get(app) ?? context.task.name;
    const failed = context.task.result?.state === 'fail';
    if (failed) await saveArtifacts(app, name);
    const problems = app.problems();
    const leftover = app.mock.unconsumed();
    const allow = (app as Launched & { allowUnconsumed?: boolean }).allowUnconsumed === true;
    await app.close();
    if (!failed) {
      if (problems.length > 0) throw new Error(`renderer reported problems:\n${problems.join('\n')}`);
      if (!allow && leftover > 0) throw new Error(`${leftover} scripted model turn(s) were never requested`);
    }
  }
});
