/**
 * `aragon info` / `aragon doctor` (cli-integration-surface section 4.3 / 5.4 /
 * AC-21 / AC-22).
 *
 * "INSTALL AND CALL" ACROSS VERSIONS IS ONLY ROBUST IF THE CALLER CAN ASK WHAT
 * IT JUST INSTALLED, so the shape of `info --json` is a contract in the same
 * sense the event schema is - and `features` is asserted as a FLAT LIST, because
 * that is the property that lets a wrapper keep working across versions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInfo } from '../diagnostics/info.js';
import { runDoctorChecks } from '../diagnostics/doctor.js';
import { EXEC_SCHEMA_VERSION } from '../exec/events.js';
import { HOST_TOOL_NAMES } from '../tools/index.js';

describe('AC-21: aragon info --json', () => {
  it('parses and carries schemaVersion, features and tools', () => {
    const info = buildInfo({}, '0.6.0');
    const round = JSON.parse(JSON.stringify(info)) as typeof info;
    expect(round.cli).toBe('0.6.0');
    expect(round.schemaVersion).toBe(EXEC_SCHEMA_VERSION);
    expect(round.tools).toEqual([...HOST_TOOL_NAMES]);
    expect(round.outputFormats).toEqual(['text', 'json', 'stream-json']);
    expect(round.inputFormats).toEqual(['text', 'stream-json']);
    expect(round.permissionModes).toEqual(['auto', 'plan', 'strict']);
  });

  it('reports features as a flat list a wrapper can test membership on', () => {
    const info = buildInfo({}, '0.6.0');
    expect(Array.isArray(info.features)).toBe(true);
    for (const feature of ['exec', 'sessions', 'permissions', 'budgets']) {
      expect(info.features).toContain(feature);
    }
    expect(info.features.every((f) => typeof f === 'string')).toBe(true);
  });

  it('names the resolved core version rather than the dependency range', () => {
    // `"^0.2.12"` is what was ASKED FOR; a consumer wants what is loaded, and
    // the two differ on every machine that installed a patch release.
    expect(buildInfo({}, '0.6.0').core).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('points at the paths a wrapper needs to clean up after itself', () => {
    const info = buildInfo({}, '0.6.0');
    expect(info.sessionsDir).toContain('sessions');
    expect(info.configPath).toContain('config.json');
  });
});

describe('AC-22: aragon doctor', () => {
  // "No API key is resolvable" must be ENFORCED, not assumed. The vitest home
  // root isolates the config-file layer, but the env layer of loadConfig() is
  // process-global state shared by every test file this worker has already run:
  // config.test.ts's precedence tests once leaked ANTHROPIC_API_KEY here and
  // turned this suite into an order-dependent release failure. The developer's
  // own shell may also export a provider key (GEMINI_API_KEY, say).
  beforeEach(() => {
    for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']) {
      vi.stubEnv(name, undefined);
    }
  });
  afterEach(() => vi.unstubAllEnvs());

  it('reports a named failing check when no API key is resolvable', async () => {
    // With the provider env layer stubbed away, there is no key from any
    // layer: exactly the state a machine is in before it is set up.
    const report = await runDoctorChecks({});
    expect(report.ok).toBe(false);
    const failed = report.checks.filter((c) => c.verdict === 'fail').map((c) => c.name);
    expect(failed).toContain('api-key');
  });

  it('passes the checks that do not depend on a key, and every check has a remedy', async () => {
    const report = await runDoctorChecks({});
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName.node?.verdict).toBe('pass');
    expect(byName.sessions?.verdict).toBe('pass');
    for (const check of report.checks) {
      if (check.verdict === 'pass') continue;
      // A `fail` with no remedy makes the caller guess, which is the state this
      // command exists to end.
      expect(check.remedy.length).toBeGreaterThan(0);
    }
  });

  it('is clean when a key is supplied through the flags', async () => {
    const report = await runDoctorChecks({ apiKey: 'sk-test', provider: 'anthropic' });
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName['api-key']?.verdict).toBe('pass');
    // ONLY `fail` moves the exit code: a `warn` (an unknown model, say) must not
    // make `aragon doctor` unusable in the CI job it is for.
    expect(report.ok).toBe(true);
  });
});
