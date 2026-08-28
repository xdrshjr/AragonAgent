/**
 * Built-in slash commands (spec §5.2):
 * /help /model /settings /thinking /max-tokens /tools /clear /reset /cwd /save
 * /resume /copy /exit (/quit), plus the /team, /fast and /todo subsystems.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { resolveOutputTokens } from '@aragon-agent/core';
import {
  clampThinkingLevel,
  clampTheme,
  isAdapterProvider,
  isThemeName,
  parseMaxTokensInput,
  ADAPTER_PROVIDERS,
  DEFAULT_MAX_TOKENS,
  HARD_MAX_RETRIES,
  LEGACY_DARK_THEME,
  THEME_NAMES,
  THINKING_LEVELS,
  type FastConfig,
  type PersistedConfig,
} from '../config/schema.js';
import type { AgentController } from '../agent/controller.js';
import { computeCost, formatCost, formatDuration, formatTokens } from '../agent/usage.js';
import type { Entry } from '../agent/reducer.js';
import { TODO_FOLLOW_LIMITS } from '../todo/limits.js';
import { buildContinuationMessage } from '../todo/follow-through.js';
import type { FollowThroughMode } from '../todo/types.js';
import { MODE_LABEL, nextMode } from '../agent/agent-mode.js';
import { loadConfig } from '../config/load.js';
import { loadSession, resolveSessionPath, saveSession } from '../session/persist.js';
import { getLogger } from '../logging/logger.js';
import { copyText } from '../ui/clipboard.js';
import { perfCommand } from './perf.js';
import { runCompactCommand } from '../compaction/command.js';
import { CommandRegistry, type SlashCommand } from './registry.js';
// `import type` for the reason `commands/registry.ts` records: tsc erases the
// specifier, so `/update` gains no runtime edge into `update/` (§3.1 rule 1).
import type { UpdateCommandPort, UpdateSnapshot } from '../update/types.js';

/**
 * `/fast status` — THE GUARANTEED REPORTING SURFACE for the tier (§4.4 / R-8).
 *
 * The chip degrades on a narrow terminal and the card only appears when a review
 * happens; this is the one place that always answers "is it on, what is it, and
 * has it done anything". The session totals are here rather than on the status
 * bar because the aggregate there cannot answer "is the cheap tier actually
 * saving me anything?".
 *
 * `unknown (no price table for <model>)` RATHER THAN A CURRENCY AMOUNT when the
 * static table has never seen the model (C-11 / RV-4 / AC-34): `$0.00` on a
 * feature that is spending money is the same class of lie as pricing a Haiku
 * child at Sonnet rates.
 */
/**
 * `/update status` - the human-readable readout (cli-auto-update §4.4).
 *
 * ASCII ONLY and NO GLYPHS: this string goes into a transcript `notice`, which
 * `Transcript.tsx` renders with its own marker; the glyph tier belongs to the
 * bottom-row line, not here. Everything a user could want to act on is named:
 * what is running, what is available, how it got installed, and when we look
 * again.
 */
function formatUpdateStatus(port: UpdateCommandPort, override?: UpdateSnapshot): string {
  const snapshot = override ?? port.snapshot();
  const lines = [
    `Auto-update: ${snapshot.phase}`,
    `  running   ${snapshot.currentVersion}`,
    `  latest    ${snapshot.latestVersion ?? 'unknown'}`,
    `  source    ${snapshot.source}`,
  ];
  if (snapshot.reason) lines.push(`  reason    ${snapshot.reason}`);
  if (snapshot.advice) lines.push(`  install   ${snapshot.advice}`);
  // The three hardening lines, each only when it has something to say
  // (cli-auto-update-hardening section 6.3).
  //
  // THE KEY COLUMN IS TEN WIDE, WHICH IS WHY THE FIRST KEY IS `rollback` AND NOT
  // `rolledback`. Section 6.3 asks for "a padded key, matching the six lines
  // `formatUpdateStatus` already emits", and every one of those pads the key to
  // ten so the values start in the same column - the entire reason a readout is
  // padded at all. `rolledback` is ten characters on its own, so it cannot take
  // a separating space without pushing its value one column past the other six,
  // which is the misalignment the padding exists to prevent. The spec's sample
  // block is internally consistent (all three new lines at eleven) and
  // inconsistent with the six it says it matches; the prose is the requirement.
  //
  // THE ROLLBACK LINE CARRIES NO FAILURE COUNT on purpose: `bootFailures` is
  // zeroed by the rollback itself, so any number printed here would be `0`. The
  // count that mattered is in the `update_rolled_back` log record.
  if (snapshot.rolledBackFrom) {
    const to = snapshot.rolledBackTo ?? snapshot.currentVersion;
    lines.push(`  rollback  ${snapshot.rolledBackFrom} -> ${to}`);
  }
  // What `aragon update --rollback` would reinstall. This is the only place a
  // user can find that out BEFORE running the command.
  if (snapshot.lastGoodVersion) lines.push(`  lastgood  ${snapshot.lastGoodVersion}`);
  // The only place a user can learn their machine updates through the fallback.
  if (snapshot.probe) {
    lines.push(`  probe     ${snapshot.probe === 'npm' ? 'npm (proxy fallback)' : 'http'}`);
  }
  if (snapshot.consecutiveFailures > 0) {
    lines.push(`  failures  ${snapshot.consecutiveFailures} in a row`);
  }
  const next = override ? port.nextCheckAt() : snapshot.nextCheckAt;
  lines.push(`  next      ${next ? new Date(next).toLocaleTimeString() : 'not scheduled'}`);
  return lines.join('\n');
}

function formatFastStatus(controller: AgentController): string {
  const status = controller.getFastStatus();
  const cfg = controller.getFastConfig();

  const state = !status.registered
    ? 'off for this session (not configured at launch)'
    : status.enabled
    ? 'on'
    : 'off';

  const lines: string[] = [];
  if (status.tier.ok) {
    const same = status.tier.sameAsMain ? '  (same as main)' : '';
    lines.push(
      `Fast tier: ${state}. Model: ${status.tier.ref.providerId}:${status.tier.ref.modelId}${same}.`,
    );
  } else {
    lines.push(`Fast tier: ${state}. Model: ${cfg.model || '(not set)'}.`);
  }

  lines.push(
    `Review: ${cfg.review ? `every ${cfg.reviewEveryTurns} turns` : 'off'}. ` +
      `Delegation: ${cfg.delegate ? 'on' : 'off'}.`,
  );

  const snapshot = status.snapshot;
  const cost = snapshot.pricingUnknown
    ? `unknown (no price table for ${snapshot.model})`
    : formatCost(
        computeCost(
          snapshot.usage,
          status.tier.ok ? controller.getModelInfoFor(status.tier.ref).cost : undefined,
        ),
      );
  // `n/N`, NEVER A BARE `n` (fast-model-tier-hardening §4.3). A bare count
  // answers "what have I spent" only for a reader who already knows the
  // ceiling, which is precisely what the user does not know; `12/40` answers
  // that and "how much is left" in the same three characters, and makes the
  // budget discoverable to someone who never read the config schema. The
  // exhausted form names the remedy inline, because a status line that reports
  // a stop without its escape hatch just relocates the question.
  //
  // `budgetReached` is READ, not re-derived (RV-H10): with the tier off both
  // numbers are `0` placeholders and `reviews >= reviewBudget` would be true.
  const budget = snapshot.budgetReached ? ' (budget reached - raise with /fast budget <n>)' : '';
  lines.push(
    `This session: ${snapshot.reviews}/${snapshot.reviewBudget} reviews${budget}, ` +
      `${snapshot.delegated} delegated subagents, ` +
      `in ${formatTokens(snapshot.usage.inputTokens)} / out ` +
      `${formatTokens(snapshot.usage.outputTokens)}, cost ${cost}.`,
  );
  return lines.join('\n');
}

const COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    description: 'Show keybindings and commands',
    run: (ctx) => ctx.setOverlay('help'),
  },
  {
    name: 'model',
    description: 'Open the model picker',
    run: (ctx) => ctx.setOverlay('model'),
  },
  {
    name: 'settings',
    description: 'Open the settings screen',
    run: (ctx) => ctx.setOverlay('settings'),
  },
  {
    name: 'thinking',
    description: 'Set the thinking level',
    run: (ctx) => {
      const level = ctx.args.trim();
      if (!level) {
        ctx.notify('info', `Thinking levels: ${THINKING_LEVELS.join(', ')}.`);
        return;
      }
      const clamped = clampThinkingLevel(level, ctx.controller.getConfig().thinkingLevel);
      ctx.controller.setThinkingLevel(clamped);
      ctx.persistConfig({ thinkingLevel: clamped });
      ctx.toast('info', `Thinking level set to "${clamped}".`);
    },
  },
  {
    name: 'max-tokens',
    description: 'Show or set the output token cap (<n> | auto | default)',
    /**
     * Exists next to the settings screen for the reason `/theme` and `/plan` do:
     * the slash palette is the discoverable surface, and this is one keystroke
     * instead of five arrow presses.
     *
     * The no-argument branch reports the EFFECTIVE cap, not just the setting.
     * "I set 64000" and "this model will produce 8192" are different facts, and
     * only the second one explains a truncated answer.
     */
    run: (ctx) => {
      const arg = ctx.args.trim();
      const cfg = ctx.controller.getConfig();

      if (!arg) {
        const resolution = resolveOutputTokens({
          providerId: cfg.provider,
          modelId: cfg.model,
          ...(cfg.maxTokens !== undefined ? { requested: cfg.maxTokens } : {}),
        });
        const setting = cfg.maxTokens === undefined ? 'auto' : String(cfg.maxTokens);
        const why = resolution.clampedBy === 'ceiling' ? ` (${cfg.model} ceiling)` : '';
        ctx.notify(
          'info',
          `Max tokens: ${setting}. Effective for ${cfg.provider}:${cfg.model}: ` +
            `${resolution.value}${why}.\nUse /max-tokens <n|auto|default>.`,
        );
        return;
      }

      const parsed = arg.toLowerCase() === 'default'
        ? ({ kind: 'value', value: DEFAULT_MAX_TOKENS, clamped: false } as const)
        : parseMaxTokensInput(arg);

      if (parsed.kind === 'invalid') {
        // Change NOTHING on a typo: silently resolving it to a default would
        // discard the number the user meant to type.
        ctx.notify('warn', `Invalid value "${arg}" - use /max-tokens <n|auto|default>.`);
        return;
      }

      if (parsed.kind === 'auto') {
        ctx.controller.setMaxTokens(undefined);
        ctx.persistConfig({ maxTokens: null });
        ctx.toast('success', 'Max tokens: auto (per-model ceiling).');
        return;
      }

      ctx.controller.setMaxTokens(parsed.value);
      ctx.persistConfig({ maxTokens: parsed.value });
      ctx.toast('success', `Max tokens set to ${parsed.value}.`);
    },
  },
  {
    name: 'theme',
    description: 'Switch the color theme (auto|warm|cool|light)',
    run: (ctx) => {
      const arg = ctx.args.trim().toLowerCase();
      const current = ctx.controller.getConfig().theme;
      if (!arg) {
        ctx.notify('info', `Theme: ${current}. Use /theme <auto|warm|cool|light>.`);
        return;
      }
      // Validate BEFORE clamping. The old `arg !== clampTheme(arg)` test would
      // now reject `/theme dark`, which is a legal compatibility alias for
      // `cool` rather than an unknown name (§4.5).
      if (!isThemeName(arg) && arg !== LEGACY_DARK_THEME) {
        ctx.notify('warn', `Unknown theme "${arg}" - use ${THEME_NAMES.join(', ')}.`);
        return;
      }
      const name = clampTheme(arg, current);
      ctx.controller.setTheme(name);
      ctx.persistConfig({ theme: name });
      ctx.toast('success', `Theme set to ${name}.`);
    },
  },
  {
    name: 'plan',
    description: 'Toggle plan mode (on | off | status)',
    // Exists next to Shift+Tab for two reasons: a handful of terminal
    // multiplexer and remote-desktop stacks never send `CSI Z` at all (R-P1),
    // and slash commands are the discoverable surface — `/` opens the palette.
    run: (ctx) => {
      const arg = ctx.args.trim().toLowerCase();
      if (arg === 'status') {
        const s = ctx.controller.getPlanStatus();
        const pending = s.pending ? ` (pending ${MODE_LABEL[s.pending]} after this run)` : '';
        ctx.notify(
          'info',
          `Mode: ${MODE_LABEL[s.effective]}${pending}. ` +
            `Ask rounds used: ${s.askRoundsUsed}/${s.maxAskRounds}.`,
        );
        return;
      }
      if (arg.length > 0 && arg !== 'on' && arg !== 'off') {
        ctx.notify('warn', `Unknown argument "${arg}" - use /plan [on|off|status].`);
        return;
      }
      const current = ctx.controller.getAgentMode();
      const target = arg === 'on' ? 'plan' : arg === 'off' ? 'build' : nextMode(current);
      ctx.applyAgentMode(target);
    },
  },
  {
    name: 'team',
    description: 'Team subagents: status | on | off | max <n>',
    /**
     * `/team on` CANNOT turn team mode on in a session that started without it,
     * and this command must not pretend otherwise (§4.5 / D-17 / P0-2).
     *
     * `controller.ts` builds the tool array ONCE and its own comment forbids
     * rebuilding it: `Agent.setTools()` mutates the live `ToolRegistry`, and
     * `submit_plan` flips the session mode from INSIDE a tool execution, so a
     * rebuild at that moment would mutate the registry mid-iteration. But
     * `rebuildSystemPrompt()` IS a live path — so the naive reading of `/team on`
     * (flip a flag, re-splice `<team_mode>`) produces a session where the model
     * is told it has a `task` tool that was never registered. Every call comes
     * back "unknown tool", and the model has no way to discover why.
     *
     * So the answer splits by what was decided at construction, and the honest
     * branch — persist it, say the session is unchanged — is the whole point.
     */
    run: (ctx) => {
      const arg = ctx.args.trim().toLowerCase();
      const [verb, value] = arg.split(/\s+/, 2);
      const controller = ctx.controller;

      // Refused mid-dispatch for the reason `/reload` already records: half a
      // dispatch under one ceiling and half under another produces a result
      // nothing can afterwards explain.
      if (verb && verb !== 'status' && controller.isTeamBusy()) {
        ctx.notify('warn', 'Cannot change team settings mid-dispatch.');
        return;
      }

      if (!verb || verb === 'status') {
        const cfg = controller.getTeamConfig();
        const state = !controller.isTeamRegistered()
          ? 'off for this session (started with --no-team)'
          : controller.isTeamEnabled()
          ? 'on'
          : 'off';
        const snapshot = controller.getTeamSnapshot();
        const roster = snapshot
          ? `\nRunning: ${snapshot.runs.map((r) => `${r.label} (${r.phase})`).join(', ')}`
          : '';
        ctx.notify(
          'info',
          `Team mode: ${state}. Max subagents: ${cfg.maxSubagents}, ` +
            `concurrent: ${cfg.maxConcurrent}.${roster}`,
        );
        return;
      }

      if (verb === 'on' || verb === 'off') {
        const enabled = verb === 'on';
        // A PARTIAL `team` section, safe only because `updatePersistedConfig`
        // deep-merges it — the same contract `/skills disable` relies on.
        ctx.persistConfig({ team: { enabled } as PersistedConfig['team'] });
        if (!controller.isTeamRegistered()) {
          // The bottom-right cell of §4.5's table. It is honest, it is one
          // sentence, and it keeps AC-11 intact: a `--no-team` session never
          // grows a wrapper or an entry, whatever the user types afterwards.
          ctx.notify(
            'info',
            enabled
              ? 'Team mode is off for this session (started with --no-team). Saved for next launch.'
              : 'Team mode is already off for this session. Saved for next launch.',
          );
          return;
        }
        controller.setTeamEnabled(enabled);
        ctx.toast('success', `Team mode ${enabled ? 'on' : 'off'}.`);
        return;
      }

      if (verb === 'max') {
        const n = Number.parseInt(value ?? '', 10);
        if (!Number.isFinite(n) || n <= 0) {
          ctx.notify('warn', 'Usage: /team max <n>');
          return;
        }
        // Clamped by `setTeamConfig` and again on the persist path, so a value
        // above the requirement's ceiling can reach neither the runtime nor the
        // file (R-g).
        const applied = controller.setTeamConfig({ maxSubagents: n });
        ctx.persistConfig({
          team: { maxSubagents: applied.maxSubagents } as PersistedConfig['team'],
        });
        ctx.toast('success', `Max subagents set to ${applied.maxSubagents}.`);
        return;
      }

      ctx.notify('warn', `Unknown argument "${verb}" - use /team [status|on|off|max <n>].`);
    },
  },
  {
    name: 'fast',
    description:
      'Fast model tier: status | on | off | model <id> | provider <id> | same | ' +
      'review <n|off> | budget <n> | delegate on|off',
    /**
     * `/fast on` CANNOT turn the tier on in a session that started without it,
     * for the reason `/team on` above records at length: the tool array is built
     * ONCE and rebuilding it is forbidden (C-2), so a session that grew a schema
     * field mid-flight would be a session whose request payloads change shape
     * between turns.
     *
     * EVERY MUTATING BRANCH DOES THE TWO CALLS PLUS PERSIST that `/todo`
     * documents: `controller.setFastConfig(patch)` updates the object `App`
     * reads at render time AND re-resolves the tier AND rebuilds the prompt;
     * `ctx.persistConfig({ fast: patch })` survives the session. Persist alone
     * reports success and changes nothing until relaunch; the setter alone
     * forgets by morning.
     */
    run: (ctx) => {
      const arg = ctx.args.trim();
      const [rawVerb, value] = arg.split(/\s+/, 2);
      const verb = (rawVerb ?? '').toLowerCase();
      const controller = ctx.controller;

      // Refused mid-dispatch for the reason `/team` records: half a dispatch
      // under one tier and half under another produces a report nothing can
      // afterwards explain. THAT ARGUMENT IS ABOUT WRITES, so the two READS are
      // grouped and answerable (RV-H3): `/fast status` always was, and a bare
      // `/fast budget` reports the same numbers by another name. `/fast budget
      // 80` is a write and is still refused.
      const isRead = verb === 'status' || (verb === 'budget' && !value);
      if (verb && !isRead && controller.isTeamBusy()) {
        ctx.notify('warn', 'Cannot change fast-tier settings mid-dispatch.');
        return;
      }

      const persist = (patch: Partial<FastConfig>): void => {
        controller.setFastConfig(patch);
        ctx.persistConfig({ fast: patch as PersistedConfig['fast'] });
      };

      if (!verb || verb === 'status') {
        ctx.notify('info', formatFastStatus(controller));
        return;
      }

      if (verb === 'on' || verb === 'off') {
        const enabled = verb === 'on';
        persist({ enabled });
        if (!controller.isFastRegistered()) {
          // The honest branch, and the whole point of splitting by what was
          // decided at construction (§3.3). It is one sentence, and it keeps
          // AC-2 / AC-3 intact: a session launched without the tier never grows
          // a schema field, whatever the user types afterwards.
          ctx.notify(
            'info',
            enabled
              ? 'The fast tier is off for this session (not configured at launch). ' +
                'Saved for next launch.'
              : 'The fast tier is already off for this session. Saved for next launch.',
          );
          return;
        }
        controller.setFastEnabled(enabled);
        ctx.toast('success', `Fast tier ${enabled ? 'on' : 'off'}.`);
        return;
      }

      if (verb === 'model') {
        const raw = (value ?? '').trim();
        if (!raw) {
          ctx.notify('warn', 'Usage: /fast model <id>  (or provider:model)');
          return;
        }
        // `provider:model` is accepted because that is how a user thinks about a
        // tier on another vendor, and an unknown provider is rejected with THE
        // MESSAGE `cli.tsx` ALREADY PRINTS rather than a second wording for the
        // same fact (RV-16).
        const colon = raw.indexOf(':');
        if (colon > 0) {
          const provider = raw.slice(0, colon);
          const model = raw.slice(colon + 1);
          if (!isAdapterProvider(provider)) {
            ctx.notify(
              'warn',
              `Unknown provider "${provider}". Choose: ${ADAPTER_PROVIDERS.join(', ')}.`,
            );
            return;
          }
          persist({ provider, model });
          ctx.toast('success', `Fast model set to ${provider}:${model}.`);
          return;
        }
        persist({ model: raw });
        ctx.toast('success', `Fast model set to ${raw}.`);
        return;
      }

      if (verb === 'provider') {
        const raw = (value ?? '').trim();
        if (!raw) {
          ctx.notify('warn', 'Usage: /fast provider <id>');
          return;
        }
        if (!isAdapterProvider(raw)) {
          ctx.notify('warn', `Unknown provider "${raw}". Choose: ${ADAPTER_PROVIDERS.join(', ')}.`);
          return;
        }
        persist({ provider: raw });
        ctx.toast('success', `Fast provider set to ${raw}.`);
        return;
      }

      if (verb === 'same') {
        // R-e IN ONE WORD. `sameAsMain` is display-only and no branch reads it
        // (R-13): the user is allowed to run both tiers on one model, and the
        // review still costs what it costs.
        const cfg = controller.getConfig();
        persist({
          provider: cfg.provider,
          model: cfg.model,
          baseUrl: cfg.baseUrl ?? '',
        });
        ctx.toast('success', `Fast tier set to ${cfg.provider}:${cfg.model} (same as main).`);
        return;
      }

      if (verb === 'review') {
        const raw = (value ?? '').trim().toLowerCase();
        if (raw === 'off') {
          persist({ review: false });
          ctx.toast('success', 'Fast review off.');
          return;
        }
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n <= 0) {
          ctx.notify('warn', 'Usage: /fast review <n> | off');
          return;
        }
        // Clamped by `setFastConfig` and again on the persist path, so a value
        // outside the range can reach neither the runtime nor the file.
        const applied = controller.setFastConfig({ review: true, reviewEveryTurns: n });
        ctx.persistConfig({
          fast: { review: true, reviewEveryTurns: applied.reviewEveryTurns } as PersistedConfig['fast'],
        });
        ctx.toast('success', `Fast review every ${applied.reviewEveryTurns} turns.`);
        return;
      }

      if (verb === 'budget') {
        const snapshot = controller.getFastStatus().snapshot;
        const raw = (value ?? '').trim();
        if (!raw) {
          // The READ. Answerable mid-dispatch (see the guard above), and it
          // reports the same pair `/fast status` renders as `n/N`.
          ctx.notify(
            'info',
            `Fast review budget: ${snapshot.reviews} of ${snapshot.reviewBudget} used ` +
              'this session. Use /fast budget <1-500> to raise it.',
          );
          return;
        }
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n <= 0) {
          // Change NOTHING on a typo, the discipline `/max-tokens` sets: a
          // silent resolve to the default discards the number the user meant.
          ctx.notify('warn', 'Usage: /fast budget <1-500>');
          return;
        }
        // BOTH CALLS, IN THIS ORDER (RV-H4 / AC-H17). `setFastConfig` is what
        // makes a raised budget take effect LIVE - the reviewer's `budgetLimit()`
        // reads the controller's in-memory config, never disk - and it also
        // re-emits `tier_changed`, which is how the new denominator reaches the
        // status chip without a restart. See the comment on this command: a
        // persist alone reports success and changes nothing until relaunch.
        const applied = controller.setFastConfig({ reviewMaxPerSession: n });
        ctx.persistConfig({
          fast: { reviewMaxPerSession: applied.reviewMaxPerSession } as PersistedConfig['fast'],
        });
        // The APPLIED value, not the requested one, so a clamp is visible.
        ctx.toast(
          'success',
          `Fast review budget: ${applied.reviewMaxPerSession} per session. ` +
            `${snapshot.reviews} used.`,
        );
        return;
      }

      if (verb === 'delegate') {
        const raw = (value ?? '').trim().toLowerCase();
        if (raw !== 'on' && raw !== 'off') {
          ctx.notify('warn', 'Usage: /fast delegate <on|off>');
          return;
        }
        persist({ delegate: raw === 'on' });
        ctx.toast('success', `Fast delegation ${raw}.`);
        return;
      }

      ctx.notify(
        'warn',
        `Unknown argument "${verb}" - use /fast ` +
          '[status|on|off|model <id>|provider <id>|same|review <n|off>|budget <n>|' +
          'delegate on|off].',
      );
    },
  },
  {
    name: 'update',
    description: 'Auto-update: status | now | skip | off',
    /**
     * THE GUARANTEED REPORTING SURFACE for the updater (C-12 / D-18).
     *
     * The bottom row can be preempted by a toast or by the activity line, and it
     * is deliberately last in that precedence (D-2), so a user who is actually
     * working may never see it. This command always answers "is it on, what did
     * it find, and when does it look again".
     *
     * REACHES THE SERVICE THROUGH `ctx.update`, NOT THROUGH `ctx.controller`
     * (C-14 / P0-2). `/fast`, `/team` and `/todo` ride on the controller because
     * their subsystems live there; `update/` may not import `agent/` at all, so
     * it carries its own optional port. `undefined` is a legitimate state - `off`,
     * a non-TTY, or CI - and says so rather than pretending to have failed.
     */
    run: (ctx) => {
      const arg = ctx.args.trim();
      const [rawVerb] = arg.split(/\s+/, 1);
      const verb = (rawVerb ?? '').toLowerCase();
      const port = ctx.update;

      // `/update off` is the one branch that works WITHOUT a service: turning
      // something off must not require it to be running, or a user who launched
      // with `--no-update` can never make that stick.
      if (verb === 'off') {
        ctx.persistConfig({ update: { mode: 'off' } as PersistedConfig['update'] });
        ctx.toast('success', 'Auto-update off. Takes effect on the next launch.');
        return;
      }

      if (!port) {
        ctx.notify(
          'info',
          'Updates are disabled for this session (update.mode: off, a non-TTY, or CI). ' +
            'Enable with: aragon config set update.mode auto',
        );
        return;
      }

      if (!verb || verb === 'status') {
        ctx.notify('info', formatUpdateStatus(port));
        return;
      }

      if (verb === 'now') {
        // `force: true` bypasses the machine-wide throttle - a human typing this
        // is the one caller entitled to ignore `lastCheckAt`.
        void port
          .checkNow({ force: true })
          .then((snapshot) => ctx.notify('info', formatUpdateStatus(port, snapshot)))
          .catch(() => ctx.notify('warn', 'Update check failed. See the log for details.'));
        ctx.toast('info', 'Checking for updates...');
        return;
      }

      if (verb === 'skip') {
        const version = port.snapshot().latestVersion;
        if (!version) {
          ctx.notify('info', 'No update is being offered, so there is nothing to skip.');
          return;
        }
        port.skip(version);
        ctx.toast('success', `Skipped ${version}. You will hear about the next release.`);
        return;
      }

      ctx.notify('warn', `Unknown argument "${verb}" - use /update [status|now|skip|off].`);
    },
  },
  {
    name: 'todo',
    description:
      'Todo planning: status | on | off | panel on|off | follow <mode> | clear | continue',
    /**
     * `/todo on` CANNOT turn planning on in a session that started with
     * `--no-todo`, for the reason `/team on` above records at length: the tool
     * array is built ONCE and rebuilding it is forbidden (C-1), while
     * `rebuildSystemPrompt()` IS a live path — so the naive reading produces a
     * session where the model is told about a `todo_write` that was never
     * registered.
     *
     * TWO CALLS, IN THIS ORDER, FOR BOTH `on|off` AND `panel on|off`, and
     * neither pair is optional:
     *
     *   `setTodoEnabled`  re-splices `<todo_planning>` (P1-1). Without it the
     *                     block survives `/todo off` and every call comes back
     *                     refused while the instructions to keep calling are
     *                     still in the model's context.
     *   `setTodoConfig`   updates the object `App` reads at RENDER time (P1-2).
     *                     `persistConfig` only writes the file, so without it
     *                     `/todo panel off` reports success and changes nothing
     *                     until the next launch.
     *   `persistConfig`   is what survives the session, in both cases.
     */
    run: (ctx) => {
      const arg = ctx.args.trim().toLowerCase();
      const [verb, value] = arg.split(/\s+/, 2);
      const controller = ctx.controller;

      if (!verb || verb === 'status') {
        const snapshot = controller.getTodoSnapshot();
        const state = !controller.isTodoRegistered()
          ? 'off for this session (started with --no-todo)'
          : controller.isTodoEnabled()
          ? 'on'
          : 'off';
        const todoCfg = controller.getTodoConfig();
        const panel = todoCfg.panel ? 'on' : 'off';
        // THE COUNTERS APPEAR ONLY IN `auto` MODE (§4.3): printing `0/25` under
        // `notify` would advertise a budget nothing is spending.
        const follow =
          todoCfg.followThrough === 'auto'
            ? `auto (${ctx.followBudget?.used ?? 0}/` +
              `${TODO_FOLLOW_LIMITS.maxAutoContinuesPerList} used)`
            : todoCfg.followThrough;
        if (!snapshot) {
          ctx.notify(
            'info',
            `No todo list. Todo planning: ${state}. Panel: ${panel}. ` +
              `Follow-through: ${follow}.`,
          );
          return;
        }
        const active =
          snapshot.activeIndex >= 0
            ? ` In progress: "${snapshot.items[snapshot.activeIndex]?.content ?? ''}".`
            : '';
        ctx.notify(
          'info',
          `Todos: ${snapshot.doneCount}/${snapshot.total} done.${active} Panel: ${panel}. ` +
            `Follow-through: ${follow}.`,
        );
        return;
      }

      if (verb === 'on' || verb === 'off') {
        const enabled = verb === 'on';
        // A PARTIAL `todo` section, safe only because `updatePersistedConfig`
        // deep-merges it — the contract §4.2 spells out in full.
        ctx.persistConfig({ todo: { enabled } as PersistedConfig['todo'] });
        if (!controller.isTodoRegistered()) {
          ctx.notify(
            'info',
            enabled
              ? 'Todo planning is off for this session (started with --no-todo). Saved for next launch.'
              : 'Todo planning is already off for this session. Saved for next launch.',
          );
          return;
        }
        controller.setTodoEnabled(enabled);
        ctx.toast('success', `Todo planning ${enabled ? 'on' : 'off'}.`);
        return;
      }

      if (verb === 'panel') {
        if (value !== 'on' && value !== 'off') {
          ctx.notify('warn', 'Usage: /todo panel <on|off>');
          return;
        }
        const panel = value === 'on';
        controller.setTodoConfig({ panel });
        ctx.persistConfig({ todo: { panel } as PersistedConfig['todo'] });
        ctx.toast('success', `Todo panel ${panel ? 'on' : 'off'}.`);
        return;
      }

      if (verb === 'follow') {
        if (value !== 'notify' && value !== 'auto' && value !== 'off') {
          ctx.notify('warn', 'Usage: /todo follow <notify|auto|off>');
          return;
        }
        const followThrough: FollowThroughMode = value;
        // THE SAME TWO-CALL RULE AS `panel` ABOVE, minus `setTodoEnabled`:
        // nothing in `<todo_planning>` mentions follow-through (D-3), so
        // `todoEnabled` has no bearing here.
        //
        // `setTodoConfig` REBUILDS THE SYSTEM PROMPT UNCONDITIONALLY
        // (`controller.ts`), and that is fine and must be left alone: the
        // rebuild is idempotent for this key (the block does not mention
        // follow-through, so the output is byte-identical), it costs one string
        // composition PER COMMAND INVOCATION rather than per turn, and
        // `setTodoConfig` is the ONLY method that updates the object `App` reads
        // at decision time. A branch that bypassed it to avoid the rebuild would
        // trade a free string concatenation for the exact "reports success,
        // changes nothing" bug the method exists to prevent (P1-1 / P2-10).
        controller.setTodoConfig({ followThrough });
        ctx.persistConfig({ todo: { followThrough } as PersistedConfig['todo'] });
        ctx.toast(
          'success',
          followThrough === 'auto'
            ? `Follow-through: auto (up to ${TODO_FOLLOW_LIMITS.maxAutoContinuesPerList} ` +
              'continuations per plan).'
            : `Follow-through: ${followThrough}.`,
        );
        return;
      }

      if (verb === 'clear') {
        // REFUSED MID-RUN, which bounds the model/panel disagreement window to
        // zero (§1.2): between turns the model's next `todo_write` is a full
        // replacement anyway.
        if (controller.isRunning()) {
          ctx.notify('warn', 'Cannot clear the todo list while a run is in progress.');
          return;
        }
        if (!controller.getTodoSnapshot()) {
          ctx.notify('info', 'No todo list.');
          return;
        }
        controller.clearTodos();
        ctx.toast('info', 'Todo list cleared.');
        return;
      }

      if (verb === 'continue') {
        // REFUSED WHILE RUNNING TOO (P2-7). `ctx.submit` is the App's
        // `submitMessage`, which routes to `controller.steer()` when the status
        // is `running` — so the un-refused form would inject "continue the
        // remaining items" into the run that is already doing exactly that.
        if (controller.isRunning()) {
          ctx.notify('warn', 'Already running.');
          return;
        }
        const snapshot = controller.getTodoSnapshot();
        if (!snapshot || snapshot.doneCount >= snapshot.total) {
          ctx.notify('info', 'Nothing left to continue.');
          return;
        }
        // THE SAME FUNCTION THE AUTO PATH USES, which is what keeps the two from
        // drifting (D-11 / D-12). Round 1's fixed string "Continue with the
        // remaining todo items." was a REFERENCE to a `todo_write` call that a
        // long session may have scrolled out of view.
        //
        // `{ userInitiated: false }`: the user typed `/todo continue`, which the
        // slash history already has. Putting this canned paragraph under the
        // composer's up-arrow as well would be the same event recorded twice, in
        // the more verbose of the two forms (AC-17).
        ctx.submit(buildContinuationMessage(snapshot), { userInitiated: false });
        return;
      }

      ctx.notify(
        'warn',
        `Unknown argument "${verb}" - use ` +
          '/todo [status|on|off|panel on|off|follow <mode>|clear|continue].',
      );
    },
  },
  {
    name: 'retry',
    description: 'API retry: show | on | off | max <n>',
    /**
     * TWO CALLS FOR EVERY MUTATION, IN THIS ORDER, and neither is optional
     * (llm-api-retry-backoff §6.9 / §6.3):
     *
     *   `setRetryConfig`  replaces the policy on the live `ProviderRegistry`, so
     *                     the change takes effect in THIS session — and, because
     *                     `TeamRuntime` holds the same registry instance, for every
     *                     child too. Without it `/retry off` reports success and
     *                     changes nothing until the next launch.
     *   `persistConfig`   is what survives the session.
     *
     * UNLIKE `/team on` AND `/todo on` there is no "off for this session" branch:
     * retry is not a tool, nothing is registered at construction, and there is
     * therefore no state a flag could have made unreachable. `--no-retry` is a
     * starting value, not a permanent verdict.
     */
    run: (ctx) => {
      const arg = ctx.args.trim().toLowerCase();
      const [verb, value] = arg.split(/\s+/, 2);
      const controller = ctx.controller;

      if (!verb || verb === 'show' || verb === 'status') {
        const cfg = controller.getRetryConfig();
        if (!cfg.enabled || cfg.maxRetries <= 0) {
          ctx.notify(
            'info',
            `API retry: off (maxRetries ${cfg.maxRetries}). Use /retry on or /retry max <n>.`,
          );
          return;
        }
        ctx.notify(
          'info',
          `API retry: on. Up to ${cfg.maxRetries} retries, ${cfg.initialDelayMs}ms doubling to ` +
            `${cfg.maxDelayMs}ms${cfg.jitter ? ' with jitter' : ''}, ` +
            `giving up after ${Math.round(cfg.maxElapsedMs / 1000)}s. ` +
            `Retry-After ${cfg.respectRetryAfter ? 'honoured' : 'ignored'}.`,
        );
        return;
      }

      if (verb === 'on' || verb === 'off') {
        const enabled = verb === 'on';
        const applied = controller.setRetryConfig({ enabled });
        // A PARTIAL `retry` section, safe only because `updatePersistedConfig`
        // deep-merges it — the same contract `/team on` relies on.
        ctx.persistConfig({ retry: { enabled } as PersistedConfig['retry'] });
        if (enabled && applied.maxRetries <= 0) {
          // Honest rather than cheerful: `enabled` is on but the count is the
          // kill switch, so nothing will actually retry.
          ctx.notify('warn', 'API retry enabled, but maxRetries is 0 - use /retry max <n>.');
          return;
        }
        ctx.toast('success', `API retry ${enabled ? 'on' : 'off'}.`);
        return;
      }

      if (verb === 'max') {
        // `Number.isFinite` and `>= 0`, NOT `> 0`: `0` is this key's documented
        // floor and its kill switch, and rejecting it here would make `/retry max 0`
        // the one documented control that does not work (R-16).
        const n = Number.parseInt(value ?? '', 10);
        if (!Number.isFinite(n) || n < 0) {
          ctx.notify('warn', `Usage: /retry max <0-${HARD_MAX_RETRIES}>  (0 turns retry off)`);
          return;
        }
        const applied = controller.setRetryConfig({ maxRetries: n });
        ctx.persistConfig({
          retry: { maxRetries: applied.maxRetries } as PersistedConfig['retry'],
        });
        ctx.toast(
          'success',
          applied.maxRetries === 0
            ? 'API retry off (maxRetries 0).'
            : `API retry: up to ${applied.maxRetries} retries.`,
        );
        return;
      }

      ctx.notify('warn', `Unknown argument "${verb}" - use /retry [show|on|off|max <n>].`);
    },
  },
  {
    // REGISTRATION ONLY. The body lives in `compaction/command.ts` because this
    // file is already past the 1000-line guideline and `/compact` has six forms
    // plus the longest status report in the package (C-16 / P1-12).
    name: 'compact',
    description:
      'Context compaction: status | on | off | threshold <n> | keep <n> | <instructions>',
    run: (ctx) => runCompactCommand(ctx),
  },
  {
    name: 'expand',
    // DELIBERATELY LEFT TOOL-ONLY, and the asymmetry with Ctrl+O is a decision
    // rather than an oversight (§6.3). Its description says "a recent tool card",
    // it takes an N-from-last index over tool cards specifically, and widening it
    // would change what `/expand 3` means for every existing user. Ctrl+O is the
    // general expansion surface — that is where `'compaction'` was added.
    description: 'Expand / collapse a recent tool card (default: last)',
    run: (ctx) => {
      const toolEntries = ctx.state.entries.filter((e) => e.kind === 'tool');
      if (toolEntries.length === 0) {
        ctx.toast('info', 'No tool output to expand.');
        return;
      }
      const n = Number.parseInt(ctx.args.trim(), 10);
      const fromLast = Number.isFinite(n) && n > 0 ? n : 1;
      const idx = Math.max(0, toolEntries.length - fromLast);
      const target = toolEntries[idx];
      if (target) ctx.dispatch({ type: 'toggleExpand', id: target.id });
    },
  },
  {
    name: 'tools',
    description: 'List active tools',
    run: (ctx) => {
      const lines = ctx.controller
        .listTools()
        .map((t) => `- ${t.name}: ${t.description.split('\n')[0]}`)
        .join('\n');
      ctx.notify('info', `Active tools:\n${lines}`);
    },
  },
  {
    name: 'clear',
    description: 'Clear the visible transcript and the todo panel',
    run: (ctx) => {
      // A USER OVERRIDE OF A PROJECTION, the same class as `/todo clear`, so it
      // reuses reason `'user'`; I-2 and its standing exception are stated on
      // `TodoStore`. Clearing the STORE and not merely the view mirror is what
      // keeps `/save`, `/todo status|continue` and follow-through agreeing with
      // the screen — they read the store directly. `messages` is untouched:
      // clearing the conversation is still `/reset` alone.
      //
      // DELIBERATELY WITHOUT `/todo clear`'s two guards: an `isRunning()` refusal
      // would leave `/clear` unable to clear even the transcript mid-run, and an
      // early return on an empty list would skip the dispatch below entirely.
      // Clearing an empty store is already silent — it emits into a reducer
      // branch that writes two fields that are both already at their defaults.
      //
      // Bounded side effect: the emptied store re-arms `todo_write`'s "a fresh
      // plan has at least two items" gate, so a model that shrinks a plan to one
      // item right after a mid-run `/clear` gets the refusal text and retries.
      ctx.controller.clearTodos();
      ctx.dispatch({ type: 'clearTranscript' });
    },
  },
  {
    name: 'reset',
    description: 'Start a new conversation',
    run: (ctx) => {
      ctx.controller.clearMessages();
      ctx.controller.clearAllQueues();
      ctx.dispatch({ type: 'resetConversation' });
      ctx.toast('info', 'Started a new conversation.');
    },
  },
  {
    name: 'cwd',
    description: 'Show or change the tool working directory',
    run: (ctx) => {
      const arg = ctx.args.trim();
      if (!arg) {
        ctx.notify('info', `Working directory: ${ctx.controller.getCwd()}`);
        return;
      }
      const target = isAbsolute(arg) ? arg : resolve(ctx.controller.getCwd(), arg);
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        ctx.notify('error', `Not a directory: ${arg}`);
        return;
      }
      ctx.controller.setCwd(target);
      ctx.notify('info', `Working directory set to ${target}`);
    },
  },
  {
    name: 'save',
    description: 'Save the session to JSON',
    run: (ctx) => {
      try {
        const path = resolveSessionPath(ctx.args, ctx.controller.getCwd());
        const cfg = ctx.controller.getConfig();
        saveSession(path, {
          model: {
            providerId: cfg.provider,
            modelId: cfg.model,
            ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
          },
          messages: ctx.controller.getMessages(),
          entries: ctx.state.entries,
          // `/resume` restores `messages`, so the belief that justifies the
          // panel comes back — and the panel has to come back with it (§3.13).
          todos: ctx.controller.getTodoSnapshot()?.items ?? [],
        });
        ctx.notify('info', `Saved session to ${path}`);
      } catch (err) {
        ctx.notify('error', `Save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  },
  {
    name: 'resume',
    description: 'Load a saved session',
    run: (ctx) => {
      try {
        const path = resolveSessionPath(ctx.args, ctx.controller.getCwd());
        const session = loadSession(path);
        ctx.controller.replaceMessages(session.messages);
        // IN THE SAME `try`, IMMEDIATELY AFTER `replaceMessages`, so a malformed
        // file fails the whole resume rather than half of it — and AN ABSENT
        // `todos` CLEARS RATHER THAN SKIPPING (P0-2 / D-22). `replaceMessages`
        // has just discarded the conversation the current list belonged to, so
        // leaving the rail up produces a panel that disagrees with the model,
        // which §1.2 ranks below having no panel at all.
        ctx.controller.restoreTodos(session.todos ?? []);
        ctx.dispatch({ type: 'restoreEntries', entries: session.entries as Entry[] });
        if (session.model?.providerId && session.model?.modelId) {
          ctx.controller.setModel(session.model.providerId, session.model.modelId, session.model.baseUrl);
        }
        ctx.notify('info', `Resumed session from ${path}`);
      } catch (err) {
        ctx.notify('error', `Resume failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  },
  {
    name: 'copy',
    description: 'Copy the last answer to the clipboard',
    run: (ctx) => {
      const last = [...ctx.state.entries].reverse().find((e) => e.kind === 'assistant');
      if (!last || last.kind !== 'assistant' || last.text.trim().length === 0) {
        ctx.notify('warn', 'No assistant message to copy.');
        return;
      }
      // ROUTED THROUGH `ui/clipboard.ts` (§4.4.5). The duplicate spawn helper this
      // command used to own is gone, and the command gained SSH support on the
      // way: OSC 52 reaches the clipboard of the machine the USER is sitting at,
      // which the local `pbcopy` never could.
      //
      // `ctx.writeForeign` and not `stdout.write` — see the field's comment.
      const via = copyText(last.text, ctx.writeForeign);
      if (via === 'none') {
        ctx.toast('warn', 'Clipboard not available.');
        return;
      }
      // NAMES THE MECHANISM RATHER THAN CLAIMING SUCCESS: neither path is
      // detectable, and tmux without `set -g set-clipboard on` swallows OSC 52
      // silently (R-7).
      ctx.toast(
        'success',
        via === 'osc52' ? 'Sent to the terminal clipboard.' : 'Sent to the system clipboard.',
      );
    },
  },
  {
    name: 'mouse',
    description: 'Release the mouse to the terminal, or take it back',
    run: (ctx) => {
      const port = ctx.mouse;
      if (!port) {
        // Inline mode, `--no-mouse`, a non-TTY, or a console that cannot deliver
        // reports. Saying so beats pretending to toggle something that is not on.
        ctx.notify('info', 'The mouse is not captured in this session, so there is nothing to release.');
        return;
      }
      const arg = ctx.args.trim().toLowerCase();
      if (arg === 'off') {
        port.setCapture(false);
        // NAMING THE COST IS THE HONEST THING TO DO, and it is one clause. The
        // wheel goes INERT rather than back to scrolling: alternate scroll is
        // saved and disabled alongside the capture, because otherwise every notch
        // becomes a burst of arrow keys that `PromptInput` reads as prompt-history
        // recall (I-10 / P1-1).
        ctx.toast(
          'info',
          'Mouse released to the terminal - the wheel will not scroll. /mouse on gives it back.',
        );
        return;
      }
      if (arg === 'on') {
        port.setCapture(true);
        ctx.toast('info', 'Mouse captured - the wheel scrolls the transcript again.');
        return;
      }
      const captured = port.captured();
      const lines = [
        `Mouse capture: ${captured ? 'on' : 'off'}`,
        `  drag-select  ${port.selectEnabled() ? 'on' : 'off (mouseSelect is false)'}`,
        '  /mouse off   hand the mouse to your terminal for this session',
        '  /mouse on    take it back',
        '  --no-mouse   never capture it (also ARAGON_MOUSE=0)',
        '  aragon config set mouseSelect false   keep the wheel, drop drag-select',
      ];
      ctx.notify('info', lines.join('\n'));
    },
  },
  {
    name: 'logs',
    description: 'Show where this session is being logged',
    run: (ctx) => {
      const logger = getLogger();
      const suffix = logger.sinkDisabled ? `\nLogging is OFF: ${logger.sinkError}` : '';
      ctx.notify(
        'info',
        `Log file: ${logger.currentLogPath()}\nLevel: ${logger.level}` +
          ' (debug/trace record prompt and tool content)' +
          suffix,
      );
    },
  },
  {
    name: 'reload',
    description: 'Re-read config.json (after editing it in another window)',
    run: (ctx) => {
      // REFUSED WHILE RUNNING, and not out of caution: swapping provider or
      // model mid-turn would let the second half of an answer be produced under
      // different settings than the first, with nothing afterwards able to
      // explain why that answer looks the way it does.
      if (ctx.state.status === 'running') {
        ctx.notify('warn', 'Cannot reload the config while a run is in progress.');
        return;
      }
      const config = loadConfig({ cwd: ctx.controller.getCwd() });
      ctx.controller.setModel(config.provider, config.model, config.baseUrl);
      ctx.controller.setThinkingLevel(config.thinkingLevel);
      ctx.controller.setMaxTokens(config.maxTokens);
      ctx.controller.setTheme(config.theme);
      getLogger().reconfigure(config.log);
      getLogger().info('config', 'reload', { provider: config.provider, model: config.model });
      ctx.toast('success', `Reloaded config: ${config.provider}:${config.model}.`);
    },
  },
  // Lives in its own module because it is the ONLY built-in that reads the
  // render layer, and threading `ui/render-cache.js` into this file would make
  // every other command's import graph pull the renderer in with it.
  perfCommand,
  {
    name: 'bg',
    description: 'Background services: list | logs <id> [n] | stop <id|all> | status',
    /**
     * THE USER'S HANDLE ON WHAT THE AGENT LEFT RUNNING (§5.3).
     *
     * It is the LIVE view, and that is why it exists at all: the transcript
     * records EVENTS about a service (D-11) — a card printed into `<Static>`
     * cannot be rewritten — so "what is running right now" lives here, in the
     * status chip, and in `bash_output`. Without this command a user whose
     * server card scrolled away an hour ago has no way to name it.
     */
    run: async (ctx) => {
      const arg = ctx.args.trim();
      const [verb = 'list', value, count] = arg.split(/\s+/);
      const controller = ctx.controller;

      if (!controller.isBackgroundRegistered()) {
        ctx.notify('info', 'Background services are off for this session (bash.background).');
        return;
      }

      const services = controller.listServices();

      if (verb === 'status') {
        const live = controller.liveServiceCount();
        ctx.notify(
          'info',
          live === 0
            ? 'No background services running.'
            : `${live} background service${live === 1 ? '' : 's'} running.`,
        );
        return;
      }

      if (verb === 'logs') {
        if (!value) {
          ctx.notify('warn', 'Usage: /bg logs <id> [n]');
          return;
        }
        const service = controller.getServiceSnapshot(value);
        if (!service) {
          ctx.notify('warn', `No service "${value}".`);
          return;
        }
        const page = controller.readServiceLog(value);
        const n = count ? Number.parseInt(count, 10) : DEFAULT_BG_LOG_ROWS;
        const rows = page?.rows ?? [];
        const take = Number.isFinite(n) && n > 0 ? n : DEFAULT_BG_LOG_ROWS;
        const shown = rows.slice(-take);
        ctx.notify(
          'info',
          shown.length === 0
            ? `service ${service.id}: no output yet.`
            : `service ${service.id} (last ${shown.length} rows)\n${shown.join('\n')}`,
        );
        return;
      }

      if (verb === 'stop') {
        if (!value) {
          ctx.notify('warn', 'Usage: /bg stop <id|all>');
          return;
        }
        // AWAITED, unlike `doExit`'s force path: a slash command runs on a live
        // event loop, so the graceful SIGTERM -> SIGKILL ladder can run and a
        // dev server gets its chance to release its port cleanly.
        const stopped = await controller.stopService(value);
        if (stopped.length === 0) {
          ctx.notify('info', 'Nothing to stop.');
          return;
        }
        const leaked = stopped.filter((svc) => svc.killIncomplete);
        ctx.toast('success', `Stopped ${stopped.length} service${stopped.length === 1 ? '' : 's'}.`);
        if (leaked.length > 0) {
          // AN HONEST WARNING BEATS A SILENT LEAK (R-2 / P2-6). `taskkill /t`
          // cannot reach a grandchild that re-parented itself, and saying so is
          // the difference between a puzzle and a `netstat` the user knows to run.
          ctx.notify(
            'warn',
            `${leaked.map((svc) => svc.id).join(', ')} may have left a detached child - ` +
              'check with netstat/lsof if a port is still held.',
          );
        }
        return;
      }

      if (verb !== 'list' && verb !== '') {
        ctx.notify('warn', `Unknown argument "${verb}" - use /bg [list|logs|stop|status].`);
        return;
      }

      if (services.length === 0) {
        ctx.notify('info', 'No background services this session.');
        return;
      }
      const now = Date.now();
      const lines = services.map((svc) => {
        const uptime = formatDuration((svc.endedAt ?? now) - svc.startedAt);
        const where = svc.url ? `  ${svc.url}` : '';
        return `${svc.id}  ${svc.status}  ${uptime}${where}  $ ${svc.command}`;
      });
      ctx.notify('info', `Background services:\n${lines.join('\n')}`);
    },
  },
  {
    name: 'exit',
    aliases: ['quit'],
    description: 'Exit',
    run: (ctx) => ctx.exit(),
  },
];

/** Rows `/bg logs <id>` shows when the user names no count. */
const DEFAULT_BG_LOG_ROWS = 40;

export function registerBuiltinCommands(registry: CommandRegistry): void {
  for (const command of COMMANDS) registry.register(command);
}

/**
 * Every built-in command name INCLUDING aliases (`quit`), for documentation and
 * tests.
 *
 * Not for run-time conflict detection — `registerSkillCommands` probes
 * `registry.get(name)` instead, because that is the only check that stays
 * correct when commands are registered dynamically (§7.1 / P1-2).
 */
export const BUILTIN_COMMAND_NAMES: string[] = COMMANDS.flatMap((c) => [
  c.name,
  ...(c.aliases ?? []),
]).sort();

// The `copyToClipboard` helper that used to live here moved into
// `ui/clipboard.ts` (tui-selection-and-scroll-follow §4.4.5), unchanged, so that
// `/copy` and the drag-select release share ONE clipboard path instead of two
// that can drift.
