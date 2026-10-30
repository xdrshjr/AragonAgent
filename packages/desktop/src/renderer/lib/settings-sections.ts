/**
 * The settings sections, as data. Every `clamp` is the engine's own normaliser (imported from
 * `tui/model/config`), so a value the form shows as "will be saved as X" is exactly what the
 * terminal's `loadConfig` would read back. Key names come from `PersistedConfig`; the parity
 * matrix (`shared/parity-matrix.ts`) says which page each one belongs to.
 */

import {
  clampBashConfig, clampCompactionConfig, clampContextWindow, clampDensity, clampFastConfig,
  clampHumanTimeout, clampJobsConfig, clampLogConfig, clampMaxTokens, clampPromptsConfig,
  clampRetryConfig, clampSkillsConfig, clampTaskSummaryConfig, clampTeamConfig, clampTheme,
  clampThinkingLevel, clampTodoConfig, coercePositiveInt, DEFAULT_CONFIG, IDLE_TIMEOUT_MARGIN_MS,
  THINKING_LEVELS,
} from '@aragon-agent/tui/model/config/schema';
import { clampGovernanceConfig } from '@aragon-agent/tui/model/config/governance-config';
import { LOG_LEVEL_NAMES } from '@aragon-agent/tui/model/logging/levels';
import type { MessageKey } from '../i18n/index.js';
import type { EnumOption, FieldSpec, SectionSpec } from './settings-fields.js';

type Raw = Record<string, unknown>;

const asBool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

const bool = (key: string, labelKey: MessageKey, extra: { hintKey?: MessageKey; danger?: boolean } = {}): FieldSpec =>
  ({ kind: 'bool', key, labelKey, ...extra });

const int = (
  key: string, labelKey: MessageKey,
  extra: { unit?: 'ms' | 's'; allowZero?: boolean; zeroKey?: MessageKey; hintKey?: MessageKey } = {},
): FieldSpec => ({ kind: 'int', key, labelKey, ...extra });

const choice = (value: string, labelKey: MessageKey): EnumOption => ({ value, labelKey });

const GENERAL: SectionSpec = {
  id: 'general',
  titleKey: 'settings.section.appearance',
  configKey: null,
  fields: [
    {
      kind: 'enum', key: 'theme', labelKey: 'settings.field.theme',
      options: [
        choice('auto', 'settings.opt.theme.auto'), choice('warm', 'settings.opt.theme.warm'),
        choice('cool', 'settings.opt.theme.cool'), choice('light', 'settings.opt.theme.light'),
      ],
    },
    {
      kind: 'enum', key: 'density', labelKey: 'settings.field.density',
      options: [choice('comfortable', 'settings.opt.density.comfortable'), choice('compact', 'settings.opt.density.compact')],
    },
    bool('reducedMotion', 'settings.field.reducedMotion'),
    bool('hints', 'settings.field.hints'),
    bool('developerMode', 'settings.dev.label', { hintKey: 'settings.dev.hint' }),
  ],
  clamp: (raw: Raw) => ({
    theme: clampTheme(raw.theme, DEFAULT_CONFIG.theme),
    density: clampDensity(raw.density, DEFAULT_CONFIG.density),
    reducedMotion: asBool(raw.reducedMotion, DEFAULT_CONFIG.reducedMotion),
    hints: asBool(raw.hints, DEFAULT_CONFIG.hints),
    developerMode: asBool(raw.developerMode, DEFAULT_CONFIG.developerMode),
  }),
};

const MODEL_DEFAULTS: SectionSpec = {
  id: 'modelDefaults',
  titleKey: 'settings.section.modelDefaults',
  descKey: 'settings.section.modelDefaults.desc',
  configKey: null,
  fields: [
    {
      kind: 'enum', key: 'thinkingLevel', labelKey: 'settings.field.thinkingLevel',
      options: THINKING_LEVELS.map((level) => choice(level, `settings.opt.thinking.${level}` as MessageKey)),
    },
    { kind: 'autoInt', key: 'maxTokens', labelKey: 'settings.field.maxTokens', hintKey: 'settings.hint.autoAllowed' },
    { kind: 'autoInt', key: 'contextWindow', labelKey: 'settings.field.contextWindow', hintKey: 'settings.hint.contextWindow' },
  ],
  clamp: (raw: Raw) => {
    const maxTokens = raw.maxTokens;
    return {
      thinkingLevel: clampThinkingLevel(raw.thinkingLevel, DEFAULT_CONFIG.thinkingLevel),
      maxTokens: maxTokens === null ? null : clampMaxTokens(maxTokens) ?? null,
      contextWindow: clampContextWindow(raw.contextWindow, null),
    };
  },
};

const AGENT: SectionSpec = {
  id: 'agent',
  titleKey: 'settings.section.behaviour',
  configKey: null,
  fields: [
    bool('confirmTools', 'settings.field.confirmTools', { hintKey: 'settings.hint.confirmTools', danger: true }),
    int('toolTimeoutMs', 'settings.field.toolTimeoutMs', { unit: 'ms' }),
    int('idleTimeoutMs', 'settings.field.idleTimeoutMs', { unit: 'ms', hintKey: 'settings.hint.idleTimeout' }),
    bool('planModeDefault', 'settings.field.planModeDefault'),
    int('planModeHumanTimeoutMs', 'settings.field.planModeHumanTimeoutMs', { unit: 'ms' }),
    bool('showThinking', 'settings.field.showThinking'),
    bool('liveToolOutput', 'settings.field.liveToolOutput'),
    bool('historyEnabled', 'settings.field.historyEnabled', { hintKey: 'settings.hint.historyEnabled' }),
  ],
  clamp: (raw: Raw) => {
    const tool = coercePositiveInt(raw.toolTimeoutMs, DEFAULT_CONFIG.toolTimeoutMs);
    const idle = coercePositiveInt(raw.idleTimeoutMs, DEFAULT_CONFIG.idleTimeoutMs);
    return {
      confirmTools: asBool(raw.confirmTools, DEFAULT_CONFIG.confirmTools),
      toolTimeoutMs: tool,
      // The engine keeps the idle watchdog strictly above the tool timeout (spec 3.8).
      idleTimeoutMs: Math.max(idle, tool + IDLE_TIMEOUT_MARGIN_MS),
      planModeDefault: asBool(raw.planModeDefault, DEFAULT_CONFIG.planModeDefault),
      planModeHumanTimeoutMs: clampHumanTimeout(raw.planModeHumanTimeoutMs, DEFAULT_CONFIG.planModeHumanTimeoutMs),
      showThinking: asBool(raw.showThinking, DEFAULT_CONFIG.showThinking),
      liveToolOutput: asBool(raw.liveToolOutput, DEFAULT_CONFIG.liveToolOutput),
      historyEnabled: asBool(raw.historyEnabled, DEFAULT_CONFIG.historyEnabled),
    };
  },
};

const BASH: SectionSpec = {
  id: 'bash',
  titleKey: 'settings.section.bash',
  configKey: 'bash',
  fields: [
    bool('background', 'settings.field.bash.background'),
    bool('autoBackground', 'settings.field.bash.autoBackground'),
    int('startupSettleMs', 'settings.field.bash.startupSettleMs', { unit: 'ms' }),
    int('readyTimeoutMs', 'settings.field.bash.readyTimeoutMs', { unit: 'ms' }),
  ],
  clamp: (raw: Raw) => ({ ...clampBashConfig(raw) }),
};

const JOBS: SectionSpec = {
  id: 'jobs',
  titleKey: 'settings.section.jobs',
  configKey: 'jobs',
  fields: [
    bool('enabled', 'settings.field.jobs.enabled'),
    int('waitSeconds', 'settings.field.jobs.waitSeconds', { unit: 's' }),
    int('stallSeconds', 'settings.field.jobs.stallSeconds', { unit: 's' }),
    bool('persistLog', 'settings.field.jobs.persistLog'),
    bool('noticeSteer', 'settings.field.jobs.noticeSteer'),
  ],
  clamp: (raw: Raw) => ({ ...clampJobsConfig(raw) }),
};

const TEAM: SectionSpec = {
  id: 'team',
  titleKey: 'settings.page.team',
  descKey: 'settings.section.team.desc',
  configKey: 'team',
  fields: [
    bool('enabled', 'settings.field.team.enabled'),
    int('maxSubagents', 'settings.field.team.maxSubagents'),
    int('maxConcurrent', 'settings.field.team.maxConcurrent'),
    int('subagentTimeoutMs', 'settings.field.team.subagentTimeoutMs', { unit: 'ms', allowZero: true, zeroKey: 'settings.zero.noLimit' }),
    int('dispatchTimeoutMs', 'settings.field.team.dispatchTimeoutMs', { unit: 'ms', allowZero: true, zeroKey: 'settings.zero.noLimit' }),
    int('maxTurnsPerSubagent', 'settings.field.team.maxTurnsPerSubagent', { allowZero: true, zeroKey: 'settings.zero.noLimit' }),
    bool('overseer', 'settings.field.team.overseer', { hintKey: 'settings.hint.overseer' }),
    int('overseerIntervalMs', 'settings.field.team.overseerIntervalMs', { unit: 'ms', allowZero: true, zeroKey: 'settings.zero.auto' }),
    {
      kind: 'enum', key: 'model', labelKey: 'settings.field.team.model',
      options: [
        choice('main', 'settings.opt.teamModel.main'), choice('fast', 'settings.opt.teamModel.fast'),
        choice('profile', 'settings.opt.teamModel.profile'),
      ],
    },
    { kind: 'profile', key: 'modelProfileId', labelKey: 'settings.field.team.modelProfileId' },
  ],
  clamp: (raw: Raw) => ({ ...clampTeamConfig(raw) }),
};

const TODO: SectionSpec = {
  id: 'todo',
  titleKey: 'settings.page.todo',
  configKey: 'todo',
  fields: [
    bool('enabled', 'settings.field.todo.enabled'),
    bool('panel', 'settings.field.todo.panel'),
    bool('acceptance', 'settings.field.todo.acceptance', { hintKey: 'settings.hint.acceptance' }),
    {
      kind: 'enum', key: 'followThrough', labelKey: 'settings.field.todo.followThrough', hintKey: 'settings.hint.followThrough',
      options: [
        choice('notify', 'settings.opt.follow.notify'), choice('auto', 'settings.opt.follow.auto'),
        choice('off', 'settings.opt.follow.off'),
      ],
    },
  ],
  clamp: (raw: Raw) => ({ ...clampTodoConfig(raw) }),
};

const unboundFast = (view: Parameters<NonNullable<FieldSpec['showIf']>>[0]): boolean => !view?.modelProfiles?.fastId;

const FAST: SectionSpec = {
  id: 'fast',
  titleKey: 'settings.page.fast',
  descKey: 'settings.section.fast.desc',
  configKey: 'fast',
  fields: [
    bool('enabled', 'settings.field.fast.enabled'),
    { kind: 'text', key: 'provider', labelKey: 'settings.field.fast.provider', showIf: unboundFast },
    { kind: 'text', key: 'model', labelKey: 'settings.field.fast.model', showIf: unboundFast },
    { kind: 'text', key: 'baseUrl', labelKey: 'settings.field.fast.baseUrl', showIf: unboundFast },
    {
      kind: 'enum', key: 'thinkingLevel', labelKey: 'settings.field.thinkingLevel',
      options: THINKING_LEVELS.map((level) => choice(level, `settings.opt.thinking.${level}` as MessageKey)),
    },
    bool('review', 'settings.field.fast.review', { hintKey: 'settings.hint.fastReview' }),
    int('reviewEveryTurns', 'settings.field.fast.reviewEveryTurns'),
    int('reviewContextTurns', 'settings.field.fast.reviewContextTurns'),
    int('reviewMaxChars', 'settings.field.fast.reviewMaxChars'),
    int('reviewMaxPerSession', 'settings.field.fast.reviewMaxPerSession'),
  ],
  clamp: (raw: Raw) => ({ ...clampFastConfig(raw) }),
};

const TASK_SUMMARY: SectionSpec = {
  id: 'taskSummary',
  titleKey: 'settings.section.taskSummary',
  configKey: 'taskSummary',
  fields: [
    bool('enabled', 'settings.field.taskSummary.enabled'),
    bool('fallback', 'settings.field.taskSummary.fallback'),
  ],
  clamp: (raw: Raw) => ({ ...clampTaskSummaryConfig(raw) }),
};

const COMPACTION: SectionSpec = {
  id: 'compaction',
  titleKey: 'settings.page.context',
  descKey: 'settings.section.compaction.desc',
  configKey: 'compaction',
  fields: [
    bool('enabled', 'settings.field.compaction.enabled'),
    { kind: 'number', key: 'threshold', labelKey: 'settings.field.compaction.threshold', hintKey: 'settings.hint.ratio' },
    { kind: 'number', key: 'warnThreshold', labelKey: 'settings.field.compaction.warnThreshold', hintKey: 'settings.hint.ratio' },
    int('keepRecentTurns', 'settings.field.compaction.keepRecentTurns'),
    bool('useFastTier', 'settings.field.compaction.useFastTier'),
    {
      kind: 'enum', key: 'onFailure', labelKey: 'settings.field.compaction.onFailure', hintKey: 'settings.hint.onFailure',
      options: [choice('stop', 'settings.opt.failure.stop'), choice('truncate', 'settings.opt.failure.truncate')],
    },
    bool('subagents', 'settings.field.compaction.subagents'),
    bool('archive', 'settings.field.compaction.archive'),
  ],
  clamp: (raw: Raw) => ({ ...clampCompactionConfig(raw) }),
};

const RETRY: SectionSpec = {
  id: 'retry',
  titleKey: 'settings.page.retry',
  configKey: 'retry',
  fields: [
    bool('enabled', 'settings.field.retry.enabled'),
    int('maxRetries', 'settings.field.retry.maxRetries', { allowZero: true }),
    int('initialDelayMs', 'settings.field.retry.initialDelayMs', { unit: 'ms' }),
    int('maxDelayMs', 'settings.field.retry.maxDelayMs', { unit: 'ms' }),
    { kind: 'number', key: 'multiplier', labelKey: 'settings.field.retry.multiplier' },
    bool('jitter', 'settings.field.retry.jitter'),
    bool('respectRetryAfter', 'settings.field.retry.respectRetryAfter'),
    int('maxElapsedMs', 'settings.field.retry.maxElapsedMs', { unit: 'ms' }),
    bool('onPartialStream', 'settings.field.retry.onPartialStream', { hintKey: 'settings.hint.onPartialStream' }),
  ],
  clamp: (raw: Raw) => ({ ...clampRetryConfig(raw) }),
};

const GOVERNANCE: SectionSpec = {
  id: 'governance',
  titleKey: 'settings.page.governance',
  descKey: 'settings.section.governance.desc',
  configKey: 'governance',
  fields: [
    bool('enabled', 'settings.field.gov.enabled'),
    bool('shiftTab', 'settings.field.gov.shiftTab'),
    bool('panel', 'settings.field.gov.panel'),
    {
      kind: 'enum', key: 'profile', labelKey: 'settings.field.gov.profile',
      options: [
        choice('general', 'settings.opt.profile.general'), choice('ml', 'settings.opt.profile.ml'),
        choice('product', 'settings.opt.profile.product'), choice('api-security', 'settings.opt.profile.apiSecurity'),
      ],
    },
    int('maxWorkPackages', 'settings.field.gov.maxWorkPackages'),
    int('maxPhases', 'settings.field.gov.maxPhases'),
    int('maxRework', 'settings.field.gov.maxRework'),
    int('maxFixCycles', 'settings.field.gov.maxFixCycles'),
    int('minAskRounds', 'settings.field.gov.minAskRounds', { allowZero: true }),
    int('budgetTokens', 'settings.field.gov.budgetTokens', { allowZero: true, zeroKey: 'settings.zero.noLimit' }),
    bool('confirmCharter', 'settings.field.gov.confirmCharter'),
  ],
  clamp: (raw: Raw) => ({ ...clampGovernanceConfig(raw) }),
};

const SKILLS: SectionSpec = {
  id: 'skills',
  titleKey: 'settings.section.skillPolicy',
  configKey: 'skills',
  fields: [
    bool('enabled', 'settings.field.skills.enabled'),
    bool('requireApproval', 'settings.field.skills.requireApproval', { hintKey: 'settings.hint.skillApproval' }),
    bool('usageTracking', 'settings.field.skills.usageTracking'),
    bool('triage', 'settings.field.skills.triage'),
    {
      kind: 'enum', key: 'integrity', labelKey: 'settings.field.skills.integrity',
      options: [choice('off', 'settings.opt.mode.off'), choice('warn', 'settings.opt.mode.warn'), choice('strict', 'settings.opt.mode.strict')],
    },
    {
      kind: 'enum', key: 'toolPolicy', labelKey: 'settings.field.skills.toolPolicy',
      options: [choice('off', 'settings.opt.mode.off'), choice('warn', 'settings.opt.mode.warn'), choice('enforce', 'settings.opt.mode.enforce')],
    },
  ],
  clamp: (raw: Raw) => ({ ...clampSkillsConfig(raw) }),
};

const PROMPTS: SectionSpec = {
  id: 'prompts',
  titleKey: 'settings.section.promptBehaviour',
  configKey: 'prompts',
  fields: [
    bool('enabled', 'settings.field.prompts.enabled'),
    {
      kind: 'enum', key: 'insertMode', labelKey: 'settings.field.prompts.insertMode',
      options: [choice('insert', 'settings.opt.insert.insert'), choice('replace', 'settings.opt.insert.replace')],
    },
  ],
  clamp: (raw: Raw) => ({ ...clampPromptsConfig(raw) }),
};

const LOG: SectionSpec = {
  id: 'log',
  titleKey: 'settings.section.logging',
  configKey: 'log',
  fields: [
    {
      kind: 'enum', key: 'level', labelKey: 'settings.field.log.level',
      options: LOG_LEVEL_NAMES.map((level) => choice(level, `settings.opt.log.${level}` as MessageKey)),
    },
    bool('toFile', 'settings.field.log.toFile'),
    bool('redactSecrets', 'settings.field.log.redactSecrets', { hintKey: 'settings.hint.redactSecrets' }),
    int('maxFiles', 'settings.field.log.maxFiles'),
    int('previewChars', 'settings.field.log.previewChars', { allowZero: true }),
  ],
  clamp: (raw: Raw) => ({ ...clampLogConfig(raw) }),
};

export const SECTIONS = {
  general: GENERAL, modelDefaults: MODEL_DEFAULTS, agent: AGENT, bash: BASH, jobs: JOBS, team: TEAM,
  todo: TODO, fast: FAST, taskSummary: TASK_SUMMARY, compaction: COMPACTION, retry: RETRY,
  governance: GOVERNANCE, skills: SKILLS, prompts: PROMPTS, log: LOG,
} as const satisfies Record<string, SectionSpec>;

export type SectionId = keyof typeof SECTIONS;
