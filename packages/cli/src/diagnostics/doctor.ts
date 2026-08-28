/**
 * `aragon doctor` - "is this machine configured to run me?", in one exit code
 * (cli-integration-surface section 4.3).
 *
 * ASCII ONLY - `src/diagnostics/**` is inside the glyph scanner's scope.
 *
 * EVERY CHECK CARRIES A ONE-LINE REMEDY, and only `fail` affects the exit code.
 * A `warn` that failed the command would make the command useless on the many
 * machines where something is unusual but working; a `fail` with no remedy makes
 * the caller guess, which is the state this command exists to end.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { initProviders, ModelRegistry } from '@aragon-agent/core';
import { getHomeResolutionWarning, getSessionsDir, getUserDataDir } from '../config/app-paths.js';
import { readConfigFile } from '../config/store.js';
import { loadConfig, makeGetApiKey, type CliFlags } from '../config/load.js';
import { isAdapterProvider, toRetryPolicy } from '../config/schema.js';
import { MODE_TOGGLE_KEYS } from '../agent/agent-mode.js';
import { supportsWindowsVtInput } from '../ui/win-vt-input.js';

export type CheckVerdict = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  verdict: CheckVerdict;
  detail: string;
  /** What to do about it. Empty only for a `pass`. */
  remedy: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

const MIN_NODE_MAJOR = 18;

export interface DoctorOptions {
  /** One minimal API call against the configured provider. */
  probe?: boolean;
}

export async function runDoctorChecks(
  flags: CliFlags,
  opts: DoctorOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [checkNode(), ...checkVtInput(), checkHome(), checkConfigFile()];
  const config = loadConfig(flags);
  checks.push(checkProviderKey(config));
  checks.push(checkModel(config));
  checks.push(checkSessionsDir());
  if (opts.probe) checks.push(await probeProvider(config));
  return { ok: checks.every((c) => c.verdict !== 'fail'), checks };
}

function pass(name: string, detail: string): DoctorCheck {
  return { name, verdict: 'pass', detail, remedy: '' };
}

function checkNode(): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (major >= MIN_NODE_MAJOR) return pass('node', `v${process.versions.node}`);
  return {
    name: 'node',
    verdict: 'fail',
    detail: `v${process.versions.node} is below the supported floor`,
    remedy: `Install Node ${MIN_NODE_MAJOR} or newer.`,
  };
}

/**
 * Whether this console can deliver `Shift+Tab`
 * (shift-tab-mode-toggle-still-dead-on-windows, C3-2).
 *
 * `MIN_NODE_MAJOR` STAYS AT 18 and this is a separate check on purpose. The
 * install floor is about whether aragon runs; this is about one key, and raising
 * the floor to 22.17 would lock out a large, otherwise perfectly healthy Node 20
 * population over it.
 *
 * `warn`, never `fail`: aragon turns the console bit on itself at startup, and
 * `MODE_TOGGLE_KEYS.fallback` works whether or not that succeeded, so nothing
 * here is actually broken - the exit code must not say it is.
 *
 * WHY IT EXISTS AT ALL: `checkNode` passes every version this bug affects, so a
 * user whose mode toggle is dead ran the tool built to explain their machine and
 * was told it was fine (analysis section 3.7). A diagnostic that is confidently
 * wrong is worse than one that is silent - it ends the investigation.
 *
 * Returned as a list so the row simply does not exist off Windows, where there
 * is no such thing as a console input mode to report on.
 */
function checkVtInput(): DoctorCheck[] {
  if (process.platform !== 'win32') return [];
  if (supportsWindowsVtInput(process.platform, process.versions.node)) {
    return [pass('vt-input', `v${process.versions.node} delivers Shift+Tab and mouse reports`)];
  }
  return [
    {
      name: 'vt-input',
      verdict: 'warn',
      detail:
        `Node v${process.versions.node} never enables ENABLE_VIRTUAL_TERMINAL_INPUT, so this ` +
        'console reports Shift+Tab as a plain Tab and sends no mouse events',
      remedy:
        `aragon turns that bit on at startup; if a policy blocks it, ${MODE_TOGGLE_KEYS.fallback} ` +
        'and /plan toggle the mode too. Node 22.17+ (or 24.2+) removes the problem.',
    },
  ];
}

function checkHome(): DoctorCheck {
  const home = getUserDataDir();
  const warning = getHomeResolutionWarning();
  try {
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
    const probe = join(home, '.doctor-write-probe');
    writeFileSync(probe, 'ok', 'utf-8');
    unlinkSync(probe);
  } catch (err) {
    return {
      name: 'home',
      verdict: 'fail',
      detail: `${home} is not writable (${(err as Error).message})`,
      remedy: 'Fix the permissions, or point ARAGON_HOME at a directory you own.',
    };
  }
  if (warning) {
    return {
      name: 'home',
      verdict: 'warn',
      detail: `${home} (${warning})`,
      remedy: 'Set ARAGON_HOME to an absolute path if this is not where you want state kept.',
    };
  }
  return pass('home', home);
}

function checkConfigFile(): DoctorCheck {
  const { parseError } = readConfigFile();
  if (!parseError) return pass('config', 'parses');
  return {
    name: 'config',
    verdict: 'warn',
    detail: `using defaults, could not parse ${parseError}`,
    remedy: 'Run `aragon config edit` and fix the JSON, or delete the file to start over.',
  };
}

function checkProviderKey(config: ReturnType<typeof loadConfig>): DoctorCheck {
  const key = makeGetApiKey(config)(config.provider);
  if (key) return pass('api-key', `resolved for ${config.provider}`);
  return {
    name: 'api-key',
    verdict: 'fail',
    detail: `no API key for provider "${config.provider}"`,
    remedy: `Run \`aragon config\` and add one, or set the provider's key in the environment.`,
  };
}

function checkModel(config: ReturnType<typeof loadConfig>): DoctorCheck {
  if (!isAdapterProvider(config.provider)) {
    return {
      name: 'model',
      verdict: 'fail',
      detail: `unknown provider "${config.provider}"`,
      remedy: 'Run `aragon models` to see the providers this build supports.',
    };
  }
  const registry = new ModelRegistry(initProviders({ retryPolicy: toRetryPolicy(config.retry) }));
  const known = registry.getModels(config.provider).some((m) => m.id === config.model);
  if (known) return pass('model', `${config.provider}/${config.model}`);
  // WARN, NOT FAIL. The registry is a builtin list plus whatever an account can
  // discover, so a model it does not know is frequently one this account has and
  // the shipped table does not - the cost table is unknown, the run is fine.
  return {
    name: 'model',
    verdict: 'warn',
    detail: `${config.provider}/${config.model} is not in the builtin registry`,
    remedy: 'Run `aragon models` to list what this key can reach; cost reporting will be off.',
  };
}

function checkSessionsDir(): DoctorCheck {
  const dir = getSessionsDir();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const probe = join(dir, '.doctor-write-probe');
    writeFileSync(probe, 'ok', 'utf-8');
    unlinkSync(probe);
  } catch (err) {
    return {
      name: 'sessions',
      verdict: 'fail',
      detail: `${dir} is not writable (${(err as Error).message})`,
      remedy: 'Fix the permissions, or run `aragon exec --no-save-session`.',
    };
  }
  return pass('sessions', dir);
}

/**
 * `--probe`: one minimal API call.
 *
 * MODEL DISCOVERY IS THE CHEAPEST HONEST PROBE. It exercises the base URL, the
 * key and the TLS chain - which is the whole of what "can this machine reach the
 * provider" means - without spending a single completion token.
 */
async function probeProvider(config: ReturnType<typeof loadConfig>): Promise<DoctorCheck> {
  const key = makeGetApiKey(config)(config.provider);
  if (!key || !isAdapterProvider(config.provider)) {
    return {
      name: 'probe',
      verdict: 'warn',
      detail: 'skipped: no key or unknown provider',
      remedy: 'Fix the api-key check above, then run `aragon doctor --probe` again.',
    };
  }
  const registry = new ModelRegistry(initProviders({ retryPolicy: toRetryPolicy(config.retry) }));
  try {
    const models = await registry.discoverModels(config.provider, key, config.baseUrl);
    return pass('probe', `${config.provider} answered with ${models.length} model(s)`);
  } catch (err) {
    return {
      name: 'probe',
      verdict: 'fail',
      detail: `${config.provider} did not answer (${(err as Error).message})`,
      remedy: 'Check the key, the base URL and any proxy between this machine and the provider.',
    };
  }
}
