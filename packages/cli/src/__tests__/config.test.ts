import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

// Point the user-state root at a throwaway temp directory BEFORE importing the
// config modules — `app-paths.ts` resolves it once, at module load, so the
// tests never touch the developer's real `~/.aragon-agent`.
const TMP = mkdtempSync(join(tmpdir(), 'aragon-cli-cfg-'));
process.env.ARAGON_HOME = TMP;

const { loadConfig, makeGetApiKey } = await import('../config/load.js');
const { updatePersistedConfig, loadPersistedConfig, getConfigPath, readConfigFile } = await import(
  '../config/store.js'
);
const {
  maskSecret,
  clampDensity,
  clampContextWindow,
  DEFAULT_CONFIG,
  DEFAULT_LOG_CONFIG,
  MAX_CONTEXT_WINDOW,
  MIN_CONTEXT_WINDOW,
} = await import('../config/schema.js');
const { Logger, setActiveLogger, resetLoggerForTest } = await import('../logging/logger.js');
const { currentLogFileName } = await import('../logging/file-sink.js');

const CWD = TMP; // has no .env

function clearEnv(): void {
  for (const key of Object.keys(process.env)) {
    // ARAGON_HOME IS EXEMPT AND MUST STAY EXEMPT. It is this file's only
    // isolation mechanism; deleting it would send any resolution that is not
    // module-level at the developer's real home directory, which now holds the
    // API key, every saved session and every installed skill.
    if (key === 'ARAGON_HOME') continue;
    if (key.startsWith('ARAGON_') || key.endsWith('_API_KEY')) delete process.env[key];
  }
}

beforeEach(() => {
  clearEnv();
  // ONE FILE, not a recursive delete of a path some function handed back:
  // `getHomeRoot()` is the whole user root now, and a recursive delete of it is
  // unrecoverable data loss the moment the isolation above ever slips.
  rmSync(getConfigPath(), { force: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('secret masking', () => {
  it('never reveals the full secret', () => {
    const key = 'sk-ant-0123456789abcdef';
    const masked = maskSecret(key);
    expect(masked).not.toContain('0123456789');
    expect(masked).toContain('...');
    expect(masked.length).toBeLessThan(key.length);
  });

  it('fully redacts short/empty keys', () => {
    expect(maskSecret('')).toBe('(not set)');
    expect(maskSecret('short')).toBe('****');
  });

  it('defaults to ASCII so a legacy console shows dots, not question marks', () => {
    // This module has no terminal capabilities to consult and its output is
    // rendered in the settings screen, so the DEFAULT has to be the safe one
    // (spec 4.1 tier B). The UI passes its resolved glyphs explicitly.
    expect(maskSecret('short')).not.toMatch(/[^\x00-\x7f]/);
    expect(maskSecret('sk-ant-0123456789abcdef')).not.toMatch(/[^\x00-\x7f]/);
  });

  it('accepts caller-supplied glyphs for a Unicode-capable terminal', () => {
    expect(maskSecret('short', { maskChar: '•' })).toBe('••••');
    expect(maskSecret('sk-ant-0123456789abcdef', { ellipsis: '…' })).toContain('…');
  });
});

describe('config precedence: defaults < env < flags', () => {
  it('uses defaults when nothing else is set', () => {
    const cfg = loadConfig({ cwd: CWD });
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.model).toBe('claude-sonnet-4-5-20250929');
    expect(cfg.maxTokens).toBe(64_000);
  });

  it('env overrides defaults', () => {
    process.env.ARAGON_MODEL = 'env-model';
    const cfg = loadConfig({ cwd: CWD });
    expect(cfg.model).toBe('env-model');
  });

  it('flags override env', () => {
    process.env.ARAGON_MODEL = 'env-model';
    const cfg = loadConfig({ cwd: CWD, model: 'flag-model' });
    expect(cfg.model).toBe('flag-model');
  });

  it('resolves maximum-token settings with flags taking precedence', () => {
    writeFileSync(
      getConfigPath(),
      JSON.stringify({ version: 1, maxTokens: 4_096 }),
      'utf8',
    );
    process.env.ARAGON_MAX_TOKENS = '8192';
    const flags = {
      cwd: CWD,
      maxTokens: '16384',
    };

    expect(loadConfig(flags).maxTokens).toBe(16_384);
  });
});

/**
 * The output cap, all four layers (§9 cases 26-30).
 *
 * `null` is the interesting value: it is AUTO, and until `resolveMaxTokens`
 * existed it silently resolved to 64000 because `pick()` skips `null` — AUTO was
 * unreachable through every supported write path.
 */
describe('maxTokens: AUTO, precedence, and the single clamp gate', () => {
  it('case 26: no config file means the product default', () => {
    expect(loadConfig({ cwd: CWD }).maxTokens).toBe(64_000);
  });

  it('case 27: an explicit null in the file means AUTO', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ version: 1, maxTokens: null }), 'utf8');

    expect(loadConfig({ cwd: CWD }).maxTokens).toBeUndefined();
  });

  it('case 29: ARAGON_MAX_TOKENS accepts auto and ignores garbage', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ version: 1, maxTokens: 4_096 }), 'utf8');

    process.env.ARAGON_MAX_TOKENS = 'auto';
    expect(loadConfig({ cwd: CWD }).maxTokens).toBeUndefined();

    // Garbage must fall THROUGH to the file, not become AUTO: a typo in an env
    // var silently discarding the configured number is the opposite of what the
    // user asked for.
    process.env.ARAGON_MAX_TOKENS = 'abc';
    expect(loadConfig({ cwd: CWD }).maxTokens).toBe(4_096);

    process.env.ARAGON_MAX_TOKENS = '0';
    expect(loadConfig({ cwd: CWD }).maxTokens).toBeUndefined();
  });

  it('accepts auto from the flag layer too', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ version: 1, maxTokens: 4_096 }), 'utf8');

    expect(loadConfig({ cwd: CWD, maxTokens: 'auto' }).maxTokens).toBeUndefined();
  });

  it('case 30: the same clamp gate applies on read AND on write', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ version: 1, maxTokens: 900_000 }), 'utf8');
    expect(loadConfig({ cwd: CWD }).maxTokens).toBe(200_000);

    // Hardening only the read path leaves the bad number on disk, where it is
    // rewritten on every launch — "my setting won't stick", with no error.
    const merged = updatePersistedConfig({ maxTokens: 900_000 });
    expect(merged.maxTokens).toBe(200_000);
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8')).maxTokens).toBe(200_000);
  });

  it('writes null through unchanged, because null is a setting', () => {
    const merged = updatePersistedConfig({ maxTokens: null });

    expect(merged.maxTokens).toBeNull();
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8')).maxTokens).toBeNull();
    expect(loadPersistedConfig().maxTokens).toBeNull();
  });

  it('leaves the stored value alone when a patch omits the key', () => {
    updatePersistedConfig({ maxTokens: 4_096 });
    const merged = updatePersistedConfig({ model: 'other-model' });

    expect(merged.maxTokens).toBe(4_096);
  });

  it('turns an unusable value on a hand-edited file into AUTO, never a crash', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ version: 1, maxTokens: 'lots' }), 'utf8');

    expect(loadPersistedConfig().maxTokens).toBeNull();
    expect(loadConfig({ cwd: CWD }).maxTokens).toBe(64_000);
  });
});

describe('getApiKey precedence', () => {
  it('prefers the config-file key over the env var', () => {
    updatePersistedConfig({ apiKeys: { anthropic: 'file-key' } });
    process.env.ANTHROPIC_API_KEY = 'env-key';
    const cfg = loadConfig({ cwd: CWD });
    expect(makeGetApiKey(cfg)('anthropic')).toBe('file-key');
  });

  it('falls back to the env var when no file key exists', () => {
    process.env.OPENAI_API_KEY = 'env-openai';
    const cfg = loadConfig({ cwd: CWD });
    expect(makeGetApiKey(cfg)('openai')).toBe('env-openai');
  });

  it('a one-shot --api-key override wins for the active provider', () => {
    process.env.ANTHROPIC_API_KEY = 'env-key';
    const cfg = loadConfig({ cwd: CWD, provider: 'anthropic', apiKey: 'override' });
    expect(makeGetApiKey(cfg)('anthropic')).toBe('override');
  });
});

describe('timeout invariant (R1)', () => {
  it('raises idleTimeout to >= toolTimeout + 30s', () => {
    const cfg = loadConfig({ cwd: CWD, toolTimeout: '100000', idleTimeout: '50000' });
    expect(cfg.toolTimeoutMs).toBe(100_000);
    expect(cfg.idleTimeoutMs).toBe(130_000);
  });
});

describe('additive config keys (R-12: no migration, no version bump)', () => {
  it('loads a config file written before the keys existed', () => {
    // Simulates a v0.2.0 file: none of the full-screen keys are present.
    updatePersistedConfig({ model: 'legacy-model' });
    const cfg = loadConfig({ cwd: CWD });
    expect(cfg.model).toBe('legacy-model');
    // Absent ⇒ no explicit opinion, so the auto-downgrade heuristics stay live.
    expect(cfg.fullscreen).toBeUndefined();
    expect(cfg.exitTranscript).toBe(true);
    // Raised 300 -> 1000 by tui-render-performance: the horizon is no longer a
    // rendering budget, because the viewport is virtualised (L3).
    expect(cfg.transcriptWindow).toBe(1000);
    expect(cfg.transcriptRetain).toBe(1000);
    expect(cfg.renderGovernor).toBe(true);
    expect(cfg.maxRenderIntervalMs).toBe(320);
  });

  it('treats a persisted `fullscreen: true` as the default, not as a force', () => {
    updatePersistedConfig({ fullscreen: true });
    expect(loadConfig({ cwd: CWD }).fullscreen).toBeUndefined();
  });

  it('honors an opt-out from the config file and a force from the flag', () => {
    updatePersistedConfig({ fullscreen: false });
    expect(loadConfig({ cwd: CWD }).fullscreen).toBe(false);
    expect(loadConfig({ cwd: CWD, fullscreen: true }).fullscreen).toBe(true);
  });

  it('lets ARAGON_FULLSCREEN override the file but lose to the flag', () => {
    updatePersistedConfig({ fullscreen: false });
    process.env.ARAGON_FULLSCREEN = '1';
    expect(loadConfig({ cwd: CWD }).fullscreen).toBe(true);
    expect(loadConfig({ cwd: CWD, fullscreen: false }).fullscreen).toBe(false);
  });

  it('clamps transcriptWindow into [50, 20000]', () => {
    updatePersistedConfig({ transcriptWindow: 5 });
    expect(loadConfig({ cwd: CWD }).transcriptWindow).toBe(50);
    updatePersistedConfig({ transcriptWindow: 99_999 });
    expect(loadConfig({ cwd: CWD }).transcriptWindow).toBe(20_000);
  });

  // --- tui-render-performance §5.1 -------------------------------------

  it('clamps transcriptRetain into [200, 20000]', () => {
    updatePersistedConfig({ transcriptWindow: 50, transcriptRetain: 5 });
    expect(loadConfig({ cwd: CWD }).transcriptRetain).toBe(200);
    updatePersistedConfig({ transcriptRetain: 99_999 });
    expect(loadConfig({ cwd: CWD }).transcriptRetain).toBe(20_000);
  });

  it('raises transcriptRetain to transcriptWindow when the two conflict', () => {
    // Retaining fewer entries than the window can scroll to would silently make
    // part of the horizon unreachable.
    updatePersistedConfig({ transcriptWindow: 5000, transcriptRetain: 200 });
    const cfg = loadConfig({ cwd: CWD });
    expect(cfg.transcriptWindow).toBe(5000);
    expect(cfg.transcriptRetain).toBe(5000);
    // §5.1 — and it REPORTS the raise. A config value overridden without a word
    // is the one silent degradation this feature is not allowed to introduce,
    // and this field is the only channel the startup notice has.
    expect(cfg.transcriptRetainRequested).toBe(200);
  });

  it('reports nothing when the two values do not conflict', () => {
    updatePersistedConfig({ transcriptWindow: 300, transcriptRetain: 4000 });
    const cfg = loadConfig({ cwd: CWD });
    expect(cfg.transcriptRetain).toBe(4000);
    expect(cfg.transcriptRetainRequested).toBeUndefined();
  });

  it('lets --no-render-governor beat a config file that turned it on', () => {
    updatePersistedConfig({ renderGovernor: true });
    expect(loadConfig({ cwd: CWD }).renderGovernor).toBe(true);
    expect(loadConfig({ cwd: CWD, renderGovernor: false }).renderGovernor).toBe(false);
  });

  it('lets ARAGON_RENDER_GOVERNOR override the file but lose to the flag', () => {
    updatePersistedConfig({ renderGovernor: true });
    process.env.ARAGON_RENDER_GOVERNOR = '0';
    expect(loadConfig({ cwd: CWD }).renderGovernor).toBe(false);
    expect(loadConfig({ cwd: CWD, renderGovernor: true }).renderGovernor).toBe(true);
    delete process.env.ARAGON_RENDER_GOVERNOR;
  });

  it('clamps maxRenderIntervalMs into [33, 1000]', () => {
    updatePersistedConfig({ maxRenderIntervalMs: 1 });
    expect(loadConfig({ cwd: CWD }).maxRenderIntervalMs).toBe(33);
    updatePersistedConfig({ maxRenderIntervalMs: 99_999 });
    expect(loadConfig({ cwd: CWD }).maxRenderIntervalMs).toBe(1000);
    expect(loadConfig({ cwd: CWD, maxRenderInterval: '80' }).maxRenderIntervalMs).toBe(80);
  });

  it('reads ARAGON_TRANSCRIPT_RETAIN and ARAGON_MAX_RENDER_INTERVAL_MS', () => {
    process.env.ARAGON_TRANSCRIPT_RETAIN = '4321';
    process.env.ARAGON_MAX_RENDER_INTERVAL_MS = '125';
    const cfg = loadConfig({ cwd: CWD });
    expect(cfg.transcriptRetain).toBe(4321);
    expect(cfg.maxRenderIntervalMs).toBe(125);
    delete process.env.ARAGON_TRANSCRIPT_RETAIN;
    delete process.env.ARAGON_MAX_RENDER_INTERVAL_MS;
  });
});

/**
 * Frame diffing (tui-input-flicker-fix §5.1-§5.3).
 *
 * `--no-diff-render` is the documented escape hatch for a terminal that renders
 * the diffed frame wrongly, so "the flag parses but never reaches the gate" is
 * the failure that matters most here — it leaves a user who has been told to
 * pass it with no next move.
 */
describe('diffRender / syncOutput', () => {
  it('both default to true', () => {
    const cfg = loadConfig({ cwd: CWD });
    expect(cfg.diffRender).toBe(true);
    expect(cfg.syncOutput).toBe(true);
  });

  it('lets --no-diff-render beat a config file that turned it on', () => {
    updatePersistedConfig({ diffRender: true });
    expect(loadConfig({ cwd: CWD }).diffRender).toBe(true);
    expect(loadConfig({ cwd: CWD, diffRender: false }).diffRender).toBe(false);
  });

  it('lets a persisted false survive a run that passes no flag at all', () => {
    // The tri-state trap: a negative-only `--no-diff-render` declaration would
    // make commander synthesize `true` here and silently un-set the escape hatch.
    updatePersistedConfig({ diffRender: false, syncOutput: false });
    expect(loadConfig({ cwd: CWD }).diffRender).toBe(false);
    expect(loadConfig({ cwd: CWD }).syncOutput).toBe(false);
  });

  it('lets ARAGON_DIFF_RENDER / ARAGON_SYNC_OUTPUT beat the file but lose to the flag', () => {
    updatePersistedConfig({ diffRender: true, syncOutput: true });
    process.env.ARAGON_DIFF_RENDER = '0';
    process.env.ARAGON_SYNC_OUTPUT = '0';
    expect(loadConfig({ cwd: CWD }).diffRender).toBe(false);
    expect(loadConfig({ cwd: CWD }).syncOutput).toBe(false);
    expect(loadConfig({ cwd: CWD, diffRender: true }).diffRender).toBe(true);
    expect(loadConfig({ cwd: CWD, syncOutput: true }).syncOutput).toBe(true);
    delete process.env.ARAGON_DIFF_RENDER;
    delete process.env.ARAGON_SYNC_OUTPUT;
  });

  it('parses the env vars with the POSITIVE list, like ARAGON_MOUSE', () => {
    // `envBool`'s negative list would read `disable` as TRUE. Every boolean env
    // var modelled on `--fullscreen` in this package uses the positive list.
    process.env.ARAGON_DIFF_RENDER = 'disable';
    expect(loadConfig({ cwd: CWD }).diffRender).toBe(false);
    process.env.ARAGON_DIFF_RENDER = 'yes';
    expect(loadConfig({ cwd: CWD }).diffRender).toBe(true);
    delete process.env.ARAGON_DIFF_RENDER;
  });

  it('round-trips both keys through the config file', () => {
    updatePersistedConfig({ diffRender: false, syncOutput: false });
    const reloaded = loadPersistedConfig();
    expect(reloaded.diffRender).toBe(false);
    expect(reloaded.syncOutput).toBe(false);
  });

  it('declares both flag forms and routes them through toFlags into CliFlags', () => {
    // Site three of three. Without the `toFlags` line the flag never reaches
    // `CliFlags` and is inert — no compile error, no runtime error.
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.tsx'),
      'utf-8',
    );
    expect(source).toContain('--diff-render');
    expect(source).toContain('--no-diff-render');
    expect(source).toContain('--sync-output');
    expect(source).toContain('--no-sync-output');
    expect(source).toMatch(/diffRender: opts\.diffRender,/);
    expect(source).toMatch(/syncOutput: opts\.syncOutput,/);
    expect(source).toMatch(/case 'diffRender':\s*\r?\n\s*patch\.diffRender = /);
    expect(source).toMatch(/case 'syncOutput':\s*\r?\n\s*patch\.syncOutput = /);
  });
});

describe('atomic write round-trip', () => {
  it('persists and reloads a config value', () => {
    updatePersistedConfig({ model: 'persisted-model' });
    const reloaded = loadPersistedConfig();
    expect(reloaded.model).toBe('persisted-model');
    expect(existsSync(getConfigPath())).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('applies 0600 permissions on POSIX', () => {
    updatePersistedConfig({ model: 'perm-check' });
    const mode = statSync(getConfigPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('density / hints / submitCount (v0.4.0 fields)', () => {
  it('defaults to comfortable density with hints on', () => {
    const cfg = loadConfig({ cwd: CWD });
    expect(cfg.density).toBe('comfortable');
    expect(cfg.hints).toBe(true);
    expect(cfg.submitCount).toBe(0);
  });

  it('honours the tri-state --compact / --hints flags', () => {
    expect(loadConfig({ cwd: CWD, compact: true }).density).toBe('compact');
    expect(loadConfig({ cwd: CWD, compact: false }).density).toBe('comfortable');
    expect(loadConfig({ cwd: CWD, hints: false }).hints).toBe(false);
    expect(loadConfig({ cwd: CWD, hints: true }).hints).toBe(true);
    // Absent means "no opinion", which is what lets the config layer win.
    expect(loadConfig({ cwd: CWD }).density).toBe('comfortable');
  });

  it('clamps a nonsense density rather than throwing', () => {
    expect(clampDensity('sideways', 'comfortable')).toBe('comfortable');
    expect(clampDensity('compact', 'comfortable')).toBe('compact');
  });
});

/**
 * The trap this package has already fallen into twice (`--compact`,
 * `--fullscreen`): declaring only the negative form makes commander default the
 * value to `true`, which folds "the user said nothing" into "the user said yes"
 * and leaves a persisted `log.toFile: false` permanently unreachable. The flag
 * therefore has to stay THREE-state all the way down to this resolver.
 */
describe('13 — --log-file / --no-log-file tri-state', () => {
  it('lets a persisted log.toFile:false stand when no flag is given', () => {
    updatePersistedConfig({ log: { toFile: false } as typeof DEFAULT_LOG_CONFIG });
    expect(loadConfig({ cwd: CWD }).log.toFile).toBe(false);
  });

  it('--log-file overrides a persisted false', () => {
    updatePersistedConfig({ log: { toFile: false } as typeof DEFAULT_LOG_CONFIG });
    expect(loadConfig({ cwd: CWD, logFile: true }).log.toFile).toBe(true);
  });

  it('--no-log-file overrides a persisted true', () => {
    updatePersistedConfig({ log: { toFile: true } as typeof DEFAULT_LOG_CONFIG });
    expect(loadConfig({ cwd: CWD, logFile: false }).log.toFile).toBe(false);
  });

  it('defaults to writing a file when nobody has an opinion', () => {
    expect(loadConfig({ cwd: CWD }).log.toFile).toBe(true);
  });
});

describe('mouse (mouse-wheel-region-routing §5.7)', () => {
  it('mouse defaults to true and honours --no-mouse', () => {
    expect(loadConfig({ cwd: CWD }).mouse).toBe(true);
    expect(loadConfig({ cwd: CWD, mouse: false }).mouse).toBe(false);
    expect(loadConfig({ cwd: CWD, mouse: true }).mouse).toBe(true);
  });

  it('reads ARAGON_MOUSE, which the `hints` one-liner would have left dead', () => {
    // P1-9: `hints` is `flags ?? file ?? default` and reads NO env at all.
    // Copying that line would have shipped ARAGON_MOUSE as documented-but-dead,
    // so `mouse` gets its own resolver next to `resolveFullscreen`.
    process.env.ARAGON_MOUSE = '0';
    expect(loadConfig({ cwd: CWD }).mouse).toBe(false);
    process.env.ARAGON_MOUSE = 'on';
    expect(loadConfig({ cwd: CWD }).mouse).toBe(true);
    // ...and the flag still wins over it.
    expect(loadConfig({ cwd: CWD, mouse: false }).mouse).toBe(false);
  });

  it('uses the POSITIVE env list, the one --fullscreen uses', () => {
    // `env.ts` carries two mutually incompatible boolean readers and they
    // disagree on this exact value: the negative-list `envBool` would call it
    // `true`. `mouse` is modelled on `--fullscreen`, so it reads like one.
    process.env.ARAGON_MOUSE = 'disable';
    expect(loadConfig({ cwd: CWD }).mouse).toBe(false);
  });

  it('lets the config file opt out, and the flag override the file', () => {
    updatePersistedConfig({ mouse: false });
    expect(loadConfig({ cwd: CWD }).mouse).toBe(false);
    expect(loadConfig({ cwd: CWD, mouse: true }).mouse).toBe(true);
  });

  it('reads a config file written before either key existed', () => {
    updatePersistedConfig({ model: 'legacy-model' });
    expect(loadConfig({ cwd: CWD }).mouse).toBe(DEFAULT_CONFIG.mouse);
  });

  // `mouseNoticeSeen` moved to `<home>/state.json` (config-state-separation
  // §4.4) — it is bookkeeping for a one-shot notice, not a preference. Its
  // round-trip now lives in `ui-state.test.ts`, and `config-purity.test.ts`
  // asserts it can no longer come back into config.json.
});

/**
 * The one new PREFERENCE this feature adds. It is command-line only (no flag,
 * no env var, no settings-screen entry), so the round-trip through the file is
 * the whole contract. The `config set` half is covered by the source-text guard
 * below, which scans `CONFIG_SET_KEYS` and requires a matching `case`.
 */
describe('historyEnabled (config-state-separation D-9)', () => {
  it('defaults to true and round-trips through the config file', () => {
    expect(loadConfig({ cwd: CWD }).historyEnabled).toBe(true);
    updatePersistedConfig({ historyEnabled: false });
    expect(loadPersistedConfig().historyEnabled).toBe(false);
    expect(loadConfig({ cwd: CWD }).historyEnabled).toBe(false);
  });
});

/**
 * P1-2 — `runConfigSet` is a TWO-STAGE function and this codebase has already
 * shipped the half-done version once (see the comment above `'density'` /
 * `'hints'` in `CONFIG_SET_KEYS`). Membership in the Set only decides that a key
 * is not REJECTED; the `switch` is what builds the patch. A key in the Set but
 * absent from the switch falls through every case, calls
 * `updatePersistedConfig({})`, and still prints `Set <key> = <value>`: silent,
 * confident, and wrong.
 *
 * `runConfigSet` is module-private in `cli.tsx` and importing that module would
 * execute `main()`, so this is a SOURCE-TEXT guard in the same spirit as
 * `glyphs.test.ts`'s `borderStyle` scan. It covers the whole class rather than
 * just `mouse`.
 */
/**
 * AC-21 — `showThinking` reaches `CliConfig` from ALL THREE channels.
 *
 * A config-file-only test would pass with the flag and the environment variable
 * both dead: `PersistedConfig` + `DEFAULT_CONFIG` alone round-trip through
 * `config set`, appear in `config list`, and never reach `initialViewState`
 * (P1-2). Nothing fails; the setting simply does nothing. So all three are
 * exercised separately, and the default is asserted as well.
 */
describe('showThinking reaches the effective config from every channel (AC-21)', () => {
  it('defaults to false — thinking is hidden on a fresh install (D-1)', () => {
    expect(loadConfig({ cwd: CWD }).showThinking).toBe(false);
  });

  it('is read from the config file', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ version: 1, showThinking: true }), 'utf8');
    expect(loadConfig({ cwd: CWD }).showThinking).toBe(true);
  });

  it('is read from ARAGON_SHOW_THINKING, which overrides the file', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ version: 1, showThinking: false }), 'utf8');
    for (const raw of ['1', 'true', 'on', 'yes']) {
      process.env.ARAGON_SHOW_THINKING = raw;
      expect(loadConfig({ cwd: CWD }).showThinking, raw).toBe(true);
    }
    process.env.ARAGON_SHOW_THINKING = '0';
    expect(loadConfig({ cwd: CWD }).showThinking).toBe(false);
  });

  it('is read from --show-thinking / --no-show-thinking, which override both', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ version: 1, showThinking: false }), 'utf8');
    process.env.ARAGON_SHOW_THINKING = '0';
    expect(loadConfig({ cwd: CWD, showThinking: true }).showThinking).toBe(true);
    process.env.ARAGON_SHOW_THINKING = '1';
    expect(loadConfig({ cwd: CWD, showThinking: false }).showThinking).toBe(false);
  });

  it('round-trips through the persisted config', () => {
    updatePersistedConfig({ showThinking: true });
    expect(loadPersistedConfig().showThinking).toBe(true);
    expect(loadConfig({ cwd: CWD }).showThinking).toBe(true);
  });
});

/**
 * `liveToolOutput` reaches `CliConfig` from ALL THREE channels
 * (agent-activity-presentation-live §4.1).
 *
 * The same three-layer discipline as its neighbour above, and for the same
 * reason one round later: `AgentController` reads `config.liveToolOutput` at
 * construction, so a key present only in `PersistedConfig` would round-trip
 * through `config set`, be written to disk, and never allocate a store. Nothing
 * would fail; the setting would simply do nothing.
 *
 * THE DEFAULT IS THE OPPOSITE OF `showThinking`'s (D-28), which is why it is
 * asserted rather than assumed: this key ADDS the information the requirement
 * asks for, and exists as a kill switch rather than as an opt-in.
 */
describe('liveToolOutput reaches the effective config from every channel (§4.1)', () => {
  it('defaults to TRUE — the tail is on out of the box (D-28)', () => {
    expect(loadConfig({ cwd: CWD }).liveToolOutput).toBe(true);
  });

  it('is read from the config file', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ version: 1, liveToolOutput: false }), 'utf8');
    expect(loadConfig({ cwd: CWD }).liveToolOutput).toBe(false);
  });

  it('is read from ARAGON_LIVE_TOOL_OUTPUT, which overrides the file', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ version: 1, liveToolOutput: true }), 'utf8');
    for (const raw of ['0', 'false', 'off', 'no']) {
      process.env.ARAGON_LIVE_TOOL_OUTPUT = raw;
      expect(loadConfig({ cwd: CWD }).liveToolOutput, raw).toBe(false);
    }
    for (const raw of ['1', 'true', 'on', 'yes']) {
      process.env.ARAGON_LIVE_TOOL_OUTPUT = raw;
      expect(loadConfig({ cwd: CWD }).liveToolOutput, raw).toBe(true);
    }
    delete process.env.ARAGON_LIVE_TOOL_OUTPUT;
  });

  it('is read from --live-tool-output / --no-live-tool-output, which override both', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ version: 1, liveToolOutput: true }), 'utf8');
    process.env.ARAGON_LIVE_TOOL_OUTPUT = '1';
    expect(loadConfig({ cwd: CWD, liveToolOutput: false }).liveToolOutput).toBe(false);
    process.env.ARAGON_LIVE_TOOL_OUTPUT = '0';
    expect(loadConfig({ cwd: CWD, liveToolOutput: true }).liveToolOutput).toBe(true);
    delete process.env.ARAGON_LIVE_TOOL_OUTPUT;
  });

  it('round-trips through the persisted config', () => {
    updatePersistedConfig({ liveToolOutput: false });
    expect(loadPersistedConfig().liveToolOutput).toBe(false);
    expect(loadConfig({ cwd: CWD }).liveToolOutput).toBe(false);
  });

  it('is routed through `toFlags` into `CliFlags`, in both directions', () => {
    // Without the `toFlags` line the flag never reaches `CliFlags` and is inert
    // — no compile error, no runtime error, the failure `--no-mouse` records.
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.tsx'),
      'utf-8',
    );
    expect(source).toContain('--live-tool-output');
    expect(source).toContain('--no-live-tool-output');
    expect(source).toMatch(/liveToolOutput: opts\.liveToolOutput,/);
    expect(source).toMatch(/case 'liveToolOutput':\s*\r?\n\s*patch\.liveToolOutput = /);
  });
});

describe('config set: every accepted key actually writes something', () => {
  const cliSource = (): string =>
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.tsx'), 'utf-8');

  it('gives each non-log CONFIG_SET_KEYS entry a matching switch case', () => {
    const source = cliSource();
    const setBlock = /const CONFIG_SET_KEYS = new Set\(\[([\s\S]*?)\n\]\);/.exec(source);
    expect(setBlock, 'CONFIG_SET_KEYS declaration not found').not.toBeNull();

    const keys = [...setBlock![1]!.matchAll(/^\s*'([^']+)',/gm)].map((m) => m[1]!);
    // Sanity: the scan must actually be finding keys, or it passes forever.
    expect(keys).toContain('provider');
    expect(keys).toContain('mouse');

    // `log.*` keys are spread in from LOG_CONFIG_SET_KEYS and handled by
    // `applyLogConfigSet` before the switch is reached.
    //
    // A key may ALSO be handled by a dedicated early-return branch before the
    // switch (`maxTokens` needs one, because it has to echo the STORED value
    // rather than the typed one). That is still "actually writes something", so
    // it counts — a key with NEITHER form still fails, which is the whole point.
    const handled = (key: string): boolean =>
      source.includes(`case '${key}':`) || source.includes(`if (key === '${key}')`);
    const missing = keys.filter((key) => !handled(key));
    expect(missing).toEqual([]);
  });

  it('has the mouse case assign to patch.mouse, not merely exist', () => {
    expect(cliSource()).toMatch(/case 'mouse':\s*\r?\n\s*patch\.mouse = /);
  });

  it('routes --mouse / --no-mouse through toFlags into CliFlags', () => {
    // Without the `toFlags` line the flag never reaches `CliFlags` at all and
    // `--no-mouse` is inert — no compile error, no runtime error (P1-2).
    const source = cliSource();
    expect(source).toContain("--no-mouse");
    expect(source).toMatch(/mouse: opts\.mouse,/);
  });
});

/**
 * Hand-editing config.json is a supported workflow now, so the cost of a stray
 * comma went up: it silently reset the model, theme, timeouts and skills, with
 * nothing anywhere connecting the two events. Falling back to defaults is still
 * right; doing it without a word is not.
 */
describe('14 — a config file that will not parse (P1-7)', () => {
  it('falls back to defaults, reports the reason and records it', () => {
    const logDir = mkdtempSync(join(TMP, 'parse-error-log-'));
    writeFileSync(getConfigPath(), '{ "model": "kept-nowhere",, }', 'utf-8');

    const read = readConfigFile();
    expect(read.config).toBeNull();
    expect(read.parseError).toContain(getConfigPath());

    const logger = new Logger({ ...DEFAULT_LOG_CONFIG, dir: logDir });
    setActiveLogger(logger);
    try {
      const cfg = loadConfig({ cwd: CWD });
      expect(cfg.model).toBe(DEFAULT_CONFIG.model);

      logger.flushSync();
      const written = readFileSync(join(logDir, currentLogFileName()), 'utf-8');
      expect(written).toContain('config_parse_failed');
      expect(written).toContain('"lv":"error"');
    } finally {
      resetLoggerForTest();
    }
  });
});

/**
 * `paste` (tui-paste-handling section 7, T-31 of the design's list).
 *
 * Modelled on the `mouse` block above, key for key, because the traps are the
 * same ones: a flag that reaches neither `CliFlags` nor `toFlags` is inert with
 * no compile error and no runtime error, and a resolver copied from the `hints`
 * one-liner reads no env at all and ships `ARAGON_PASTE` documented-but-dead.
 */
describe('paste (tui-paste-handling section 7)', () => {
  it('defaults to true and honours --no-paste', () => {
    expect(loadConfig({ cwd: CWD }).paste).toBe(true);
    expect(loadConfig({ cwd: CWD, paste: false }).paste).toBe(false);
    expect(loadConfig({ cwd: CWD, paste: true }).paste).toBe(true);
  });

  it('reads ARAGON_PASTE, which the `hints` one-liner would have left dead', () => {
    process.env.ARAGON_PASTE = '0';
    expect(loadConfig({ cwd: CWD }).paste).toBe(false);
    process.env.ARAGON_PASTE = 'on';
    expect(loadConfig({ cwd: CWD }).paste).toBe(true);
    // ...and the flag still wins over it.
    expect(loadConfig({ cwd: CWD, paste: false }).paste).toBe(false);
    delete process.env.ARAGON_PASTE;
  });

  it('uses the POSITIVE env list, the one --fullscreen uses', () => {
    process.env.ARAGON_PASTE = 'disable';
    expect(loadConfig({ cwd: CWD }).paste).toBe(false);
    delete process.env.ARAGON_PASTE;
  });

  it('lets the config file opt out, and the flag override the file', () => {
    updatePersistedConfig({ paste: false });
    expect(loadConfig({ cwd: CWD }).paste).toBe(false);
    expect(loadConfig({ cwd: CWD, paste: true }).paste).toBe(true);
  });

  it('reads a config file written before the key existed', () => {
    updatePersistedConfig({ model: 'legacy-model' });
    expect(loadConfig({ cwd: CWD }).paste).toBe(DEFAULT_CONFIG.paste);
  });

  it('is wired at all THREE sites, and cased in the config-set switch', () => {
    // Site one is the `.option()` pair, site two is the `CliFlags` field, site
    // three is the `toFlags` line. Ten features have now paid for missing one.
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.tsx'),
      'utf-8',
    );
    expect(source).toContain("--paste");
    expect(source).toContain("--no-paste");
    expect(source).toMatch(/paste: opts\.paste,/);
    expect(source).toMatch(/case 'paste':\s*\r?\n\s*patch\.paste = /);
  });
});

/**
 * T20 - `contextWindow` (context-usage-gauge-accuracy §3.6 / RV-12).
 *
 * THE TRI-STATE IS THE WHOLE POINT, and it is copied from `maxTokens` above
 * rather than invented: `null` means AUTO, a number is clamped, and garbage
 * falls through to the layer underneath instead of silently becoming AUTO.
 */
describe('contextWindow: AUTO, precedence, and the single clamp gate', () => {
  it('defaults to AUTO, because a default number would be the invented denominator this key exists to correct', () => {
    expect(DEFAULT_CONFIG.contextWindow).toBeNull();
    expect(loadConfig({ cwd: CWD }).contextWindow).toBeNull();
  });

  it('`null` PASSES STRAIGHT THROUGH the clamp (RV-12)', () => {
    // Clamping AUTO into `[8000, ...]` yields 8000, which removes "auto" from
    // the config permanently - and the symptom is an 8k denominator with a
    // permanently red bar and no visible source.
    expect(clampContextWindow(null, 200_000)).toBeNull();
    expect(clampContextWindow(null, null)).toBeNull();
  });

  it('clamps both bounds, and falls back rather than inventing a number', () => {
    expect(clampContextWindow(1_000, null)).toBe(MIN_CONTEXT_WINDOW);
    expect(clampContextWindow(99_999_999, null)).toBe(MAX_CONTEXT_WINDOW);
    expect(clampContextWindow(1_000_000, null)).toBe(1_000_000);
    expect(clampContextWindow('nonsense', 128_000)).toBe(128_000);
    expect(clampContextWindow(undefined, 128_000)).toBe(128_000);
  });

  it('reads a number from the config file', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ version: 1, contextWindow: 1_000_000 }), 'utf8');
    expect(loadConfig({ cwd: CWD }).contextWindow).toBe(1_000_000);
  });

  it('ARAGON_CONTEXT_WINDOW accepts auto and ignores garbage', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ version: 1, contextWindow: 1_000_000 }), 'utf8');

    process.env.ARAGON_CONTEXT_WINDOW = 'auto';
    expect(loadConfig({ cwd: CWD }).contextWindow).toBeNull();

    // Garbage falls THROUGH to the file - a typo in an env var must not discard
    // the configured number.
    process.env.ARAGON_CONTEXT_WINDOW = 'abc';
    expect(loadConfig({ cwd: CWD }).contextWindow).toBe(1_000_000);

    process.env.ARAGON_CONTEXT_WINDOW = '400000';
    expect(loadConfig({ cwd: CWD }).contextWindow).toBe(400_000);
  });

  it('the same clamp gate applies on read AND on write', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ version: 1, contextWindow: 99_999_999 }), 'utf8');
    expect(loadConfig({ cwd: CWD }).contextWindow).toBe(MAX_CONTEXT_WINDOW);

    const merged = updatePersistedConfig({ contextWindow: 99_999_999 });
    expect(merged.contextWindow).toBe(MAX_CONTEXT_WINDOW);
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8')).contextWindow).toBe(MAX_CONTEXT_WINDOW);
  });

  it('writes null through unchanged, because null is a setting', () => {
    const merged = updatePersistedConfig({ contextWindow: null });
    expect(merged.contextWindow).toBeNull();
    expect(loadPersistedConfig().contextWindow).toBeNull();
  });

  it('leaves the stored value alone when a patch omits the key', () => {
    updatePersistedConfig({ contextWindow: 400_000 });
    expect(updatePersistedConfig({ model: 'other-model' }).contextWindow).toBe(400_000);
  });
});
