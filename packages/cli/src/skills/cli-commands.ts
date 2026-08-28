/**
 * `aragon skills …` — the non-interactive surface (spec §7.3).
 *
 * Exit codes match the existing `runConfigSet` convention:
 *   0 success · 1 run-time failure (network / fs / git) · 2 usage or validation.
 *
 * Nothing here renders Ink. These commands run in a one-shot process, so there
 * is no App and therefore no human channel unless `--yes` says otherwise — the
 * same fail-closed rule the agent tools follow, reached through the same gate.
 */

import process from 'node:process';
import { createNodeSkillHost } from './node-host.js';
import { SkillService, type ApprovalGate } from './service.js';
import { createSkill, installSkill, removeSkill, writableRootFor } from './installer.js';
import { checkManifest } from './manifest.js';
import { getUserSkillsDir } from './paths.js';
import { flushUsage, getUsagePath, listUsage, resetUsage } from './usage.js';
import { currentPlatform } from './node-host.js';
import { HOST_TOOL_NAMES } from '../tools/index.js';
import {
  checkSkillUpdate,
  isHardFailure,
  updateAllSkills,
  updateSkill,
  type UpdateResult,
} from './updater.js';
import { loadConfig, type CliFlags } from '../config/load.js';
import { updatePersistedConfig } from '../config/store.js';
import type { SkillsConfig } from '../config/schema.js';
import { rankCatalogRecords, type SkillRecord, type SkillScope } from '@aragon-agent/core';
import { classifyBundledFile, resolveDeclaredTool } from '@aragon-agent/core/skills';

export interface SkillsCliOptions {
  scope?: string;
  name?: string;
  description?: string;
  yes?: boolean;
  json?: boolean;
  all?: boolean;
  force?: boolean;
  dryRun?: boolean;
  check?: boolean;
  sort?: string;
  /** `skills usage --reset` — delete the local counters. */
  reset?: boolean;
}

const EXIT_OK = 0;
const EXIT_RUNTIME = 1;
const EXIT_USAGE = 2;

/**
 * `--yes` is the ONLY way a one-shot process can approve.
 *
 * There is no TTY prompt implementation here on purpose: adding one would mean
 * a half-interactive command that hangs in CI. Without `--yes`, anything
 * requiring approval fails with exit 2 and says which flag to add.
 */
function makeCliApproval(yes: boolean): ApprovalGate {
  return { canPrompt: () => yes, request: async () => yes };
}

function buildService(flags: CliFlags, yes: boolean): { service: SkillService; cwd: string } {
  const config = loadConfig(flags);
  const service = new SkillService({
    host: createNodeSkillHost(),
    getCwd: () => config.cwd,
    config: config.skills,
    runtime: { forcedSkills: [], approveAll: yes },
    approval: makeCliApproval(yes),
    notify: (level, text) => process.stderr.write(`[skills] ${level}: ${text}\n`),
    persist: (patch: Partial<SkillsConfig>) => {
      updatePersistedConfig({ skills: patch as SkillsConfig });
    },
  });
  service.discover();
  return { service, cwd: config.cwd };
}

function toJson(record: SkillRecord): Record<string, unknown> {
  return {
    name: record.name,
    version: record.frontmatter.version,
    scope: record.scope,
    description: record.description,
    dir: record.dir,
    disabled: record.disabled,
    invalid: record.invalid,
    activation: record.frontmatter.activation,
    writable: record.writable,
    shadowed: record.shadowed,
    source: record.manifest?.source ?? null,
    integrity: record.integrity,
    updatedAt: record.manifest?.updatedAt ?? null,
    previousVersion: record.manifest?.previousVersion ?? null,
  };
}

/**
 * `--sort=recent` reuses the CATALOG ranking rather than sorting by timestamp.
 *
 * The point of the flag is "show me the order the model sees", so a second,
 * subtly different notion of "recent" would answer a question nobody asked and
 * quietly disagree with the thing it is supposed to explain.
 */
function sortForListing(records: SkillRecord[], service: SkillService, sort?: string): SkillRecord[] {
  if (sort !== 'recent') return records;
  const ranked = rankCatalogRecords(records, { usage: service.getUsage() });
  const seen = new Set(ranked.map((r) => r.name));
  // Ranking drops disabled / invalid / manual entries; keep them visible at the
  // bottom, because `/skills list` is also how a user finds out WHY something
  // is not showing up.
  return [...ranked, ...records.filter((r) => !seen.has(r.name))];
}

/** Dispatch an `aragon skills <sub>` invocation and return the exit code. */
export async function runSkillsCommand(
  sub: string,
  argument: string | undefined,
  opts: SkillsCliOptions,
  flags: CliFlags,
  version: string,
): Promise<number> {
  const yes = opts.yes === true;

  if (sub === 'path') {
    process.stdout.write(`${getUserSkillsDir()}\n`);
    return EXIT_OK;
  }

  // Ahead of `buildService` like `path`: the counters live next to the skills
  // directory, not inside it, so reading or deleting them needs no scan.
  if (sub === 'usage') return runUsage(opts);

  const { service, cwd } = buildService(flags, yes);

  switch (sub) {
    case 'list': {
      const records = sortForListing(service.list(), service, opts.sort);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(records.map(toJson), null, 2)}\n`);
        return EXIT_OK;
      }
      if (records.length === 0) {
        process.stdout.write('No skills installed.\n');
        return EXIT_OK;
      }
      for (const record of records) {
        const mark = record.invalid ? '!' : record.disabled ? 'x' : '-';
        const modified = record.integrity === 'modified' ? '  !modified' : '';
        process.stdout.write(
          `${mark} ${record.name.padEnd(24)} ${record.frontmatter.version.padEnd(8)} ` +
            `${record.scope.padEnd(8)} ${record.description.replace(/\s+/g, ' ').slice(0, 60)}` +
            `${modified}\n`,
        );
      }
      for (const dir of service.untrustedDirs()) {
        process.stderr.write(`[skills] untrusted project dir skipped: ${dir}\n`);
      }
      return EXIT_OK;
    }

    case 'info': {
      if (!argument) {
        process.stderr.write('Usage: aragon skills info <name>\n');
        return EXIT_USAGE;
      }
      const record = service.get(argument);
      if (!record) {
        process.stderr.write(`No skill named "${argument}".\n`);
        return EXIT_USAGE;
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(toJson(record), null, 2)}\n`);
        return EXIT_OK;
      }
      process.stdout.write(
        [
          `${record.name} v${record.frontmatter.version} (${record.scope})`,
          record.description,
          `Path: ${record.dir}`,
          `Activation: ${record.frontmatter.activation}`,
          record.manifest
            ? `Source: ${record.manifest.source.kind} ${record.manifest.source.url}` +
              (record.manifest.source.ref ? ` @ ${record.manifest.source.ref}` : '')
            : 'Source: hand-authored (no install manifest)',
          ...(record.manifest?.updatedAt
            ? [
                `Updated: ${new Date(record.manifest.updatedAt).toISOString()}` +
                  (record.manifest.previousVersion ? ` (from v${record.manifest.previousVersion})` : ''),
              ]
            : []),
          ...(record.integrity === 'modified' ? ['Integrity: modified since install'] : []),
          '',
        ].join('\n'),
      );
      return EXIT_OK;
    }

    case 'install': {
      if (!argument) {
        process.stderr.write('Usage: aragon skills install <source> [--scope user|project] [--yes]\n');
        return EXIT_USAGE;
      }
      const scope = parseScope(opts.scope);
      if (scope === undefined && opts.scope) {
        process.stderr.write(`Unknown scope "${opts.scope}". Use user or project.\n`);
        return EXIT_USAGE;
      }
      const result = await installSkill(service, argument, {
        ...(scope ? { scope } : {}),
        ...(opts.name ? { name: opts.name } : {}),
        initiator: 'user',
        cwd,
        installer: version,
      });
      if (!result.ok) {
        process.stderr.write(`${result.error}\n`);
        return isApprovalError(result.error) ? EXIT_USAGE : EXIT_RUNTIME;
      }
      process.stdout.write(
        `Installed ${result.name} v${result.version} (${result.fileCount} files) at ${result.dir}\n`,
      );
      return EXIT_OK;
    }

    case 'update':
      return runUpdate(service, argument, opts, cwd, version);

    case 'remove': {
      if (!argument) {
        process.stderr.write('Usage: aragon skills remove <name> [--yes]\n');
        return EXIT_USAGE;
      }
      const result = await removeSkill(service, argument);
      if (!result.ok) {
        process.stderr.write(`${result.error}\n`);
        return result.reason === 'io_error' ? EXIT_RUNTIME : EXIT_USAGE;
      }
      process.stdout.write(`Removed ${argument}\n`);
      return EXIT_OK;
    }

    case 'create': {
      if (!argument || !opts.description) {
        process.stderr.write(
          'Usage: aragon skills create <name> --description <d> [--scope user|project] [--yes]\n',
        );
        return EXIT_USAGE;
      }
      const scope = parseScope(opts.scope) ?? 'user';
      if (!writableRootFor(scope, cwd)) {
        process.stderr.write(`Cannot create a skill in a ${scope} scope.\n`);
        return EXIT_USAGE;
      }
      const result = await createSkill(
        service,
        {
          name: argument,
          description: opts.description,
          // A scaffold, not a finished skill: the body is a TODO the author is
          // expected to open and fill in. Inventing prose here would produce
          // plausible-looking instructions nobody wrote.
          body: [`# ${argument}`, '', '## When to use', '', 'TODO', '', '## Steps', '', '1. TODO'].join(
            '\n',
          ),
          scope,
          initiator: 'user',
        },
        { cwd, installer: version },
      );
      if (!result.ok) {
        process.stderr.write(`${result.error}\n`);
        return isApprovalError(result.error) ? EXIT_USAGE : EXIT_RUNTIME;
      }
      process.stdout.write(`Created ${result.name} at ${result.dir}\nEdit SKILL.md to fill it in.\n`);
      return EXIT_OK;
    }

    case 'doctor': {
      let problems = 0;
      for (const record of service.list()) {
        for (const issue of record.issues) {
          if (issue.level === 'error') problems += 1;
          process.stdout.write(`${issue.level}: ${record.name}: ${issue.code} - ${issue.message}\n`);
        }
        for (const line of checkDeclaredTools(record)) process.stdout.write(line);
        for (const line of checkScriptPlatform(record, bundledFiles(service, record))) {
          process.stdout.write(line);
        }
        if (record.integrity === 'modified') {
          process.stdout.write(`warn: ${record.name}: SKILL.md changed since install\n`);
        }
        if (record.manifest) {
          const tamper = checkManifest(record.dir, record.manifest);
          for (const file of tamper.missing) {
            process.stdout.write(`warn: ${record.name}: missing file ${file}\n`);
          }
          for (const file of tamper.modified) {
            process.stdout.write(`warn: ${record.name}: modified since install ${file}\n`);
          }
        }
      }
      for (const error of service.errors()) process.stdout.write(`warn: ${error}\n`);
      process.stdout.write(
        problems === 0
          ? `Checked ${service.list().length} skills; no errors.\n`
          : `Checked ${service.list().length} skills; ${problems} error(s).\n`,
      );
      return problems === 0 ? EXIT_OK : EXIT_USAGE;
    }

    case 'trust':
    case 'untrust': {
      if (!argument) {
        process.stderr.write(`Usage: aragon skills ${sub} <dir>\n`);
        return EXIT_USAGE;
      }
      const ok = sub === 'trust' ? service.trustDir(argument) : service.untrustDir(argument);
      if (!ok) {
        process.stderr.write(
          sub === 'trust' ? `Could not resolve "${argument}".\n` : `"${argument}" was not trusted.\n`,
        );
        return EXIT_USAGE;
      }
      process.stdout.write(`${sub === 'trust' ? 'Trusted' : 'Untrusted'} ${argument}\n`);
      return EXIT_OK;
    }

    default:
      process.stderr.write(
        `Unknown subcommand "${sub}". Try: list, info, install, update, remove, create, path, ` +
          'doctor, usage, trust, untrust.\n',
      );
      return EXIT_USAGE;
  }
}

// ---------------------------------------------------------------------------
// doctor — the two checks added by this iteration (§5.7 / §8.4)
// ---------------------------------------------------------------------------

/**
 * Can this skill's `allowed-tools` ever take effect?
 *
 * Resolved against `HOST_TOOL_NAMES`, not a live tool array: this process has no
 * `AgentController` at all (P1-8), and the question doctor answers is "will this
 * declaration work?", not "is it working at this instant". Using the superset
 * also makes the output independent of how the CLI happened to be invoked, which
 * is what lets it be snapshot-tested.
 */
export function checkDeclaredTools(record: SkillRecord): string[] {
  const declared = record.frontmatter.allowedTools;
  if (declared.length === 0) return [];

  const resolved: string[] = [];
  const absent: string[] = [];
  const unknown: string[] = [];
  for (const name of declared) {
    const outcome = resolveDeclaredTool(name, HOST_TOOL_NAMES);
    if (outcome === null) unknown.push(name);
    else if (outcome === 'absent') absent.push(name);
    else resolved.push(outcome);
  }

  if (unknown.length > 0) {
    return [
      `warn: ${record.name}: tools: NOT ENFORCEABLE - unknown: ${unknown.join(', ')}. ` +
        'Fix the name or the ceiling will never apply.\n',
    ];
  }
  // Flagged rather than silently accepted: the author wrote a permission intent
  // that the system then ignores wholesale (D-G9), and nothing else says so.
  if (record.frontmatter.activation === 'always') {
    return [
      `warn: ${record.name}: tools: "${record.name}" is activation: always, ` +
        'so its allowed-tools never applies.\n',
    ];
  }
  const ignored = absent.length > 0 ? `; ignored on this host: ${absent.join(', ')}` : '';
  return [`ok: ${record.name}: tools: ok (${resolved.join(', ')})${ignored}\n`];
}

/**
 * Bundled files for a doctor check.
 *
 * `record.files` is `null` until a Level 2 load, and discovery deliberately does
 * not hydrate it. `countUse: false` because inspecting a skill is not using one
 * — counting it here would let a single `doctor` run reorder the catalog.
 */
function bundledFiles(service: SkillService, record: SkillRecord): Array<{ path: string }> {
  if (record.files) return record.files;
  try {
    return service.loadBody(record.name, { countUse: false }).files;
  } catch {
    return [];
  }
}

/** Bundled scripts that cannot run on this host's shell (§8.4). Warn, never error. */
export function checkScriptPlatform(record: SkillRecord, files: Array<{ path: string }>): string[] {
  const scripts = files.filter((f) => classifyBundledFile(f.path) === 'script');
  if (scripts.length === 0) return [];
  const platform = currentPlatform();
  const unusable = platform === 'win32' ? '.sh' : '.ps1';
  const runnable = scripts.filter((f) => !f.path.toLowerCase().endsWith(unusable));
  if (runnable.length > 0) return [];
  const shell = platform === 'win32' ? 'cmd.exe (win32)' : 'a POSIX shell';
  return [
    `warn: ${record.name}: scripts: ${record.name} bundles only ${unusable} scripts; ` +
      `this host runs ${shell}.\n`,
  ];
}

// ---------------------------------------------------------------------------
// usage (§9 / FG7)
// ---------------------------------------------------------------------------

function runUsage(opts: SkillsCliOptions): number {
  if (opts.reset) {
    // Same rule as every other mutating one-shot: `--yes` is the only approval
    // channel here, because a half-interactive prompt would hang in CI.
    if (!opts.yes) {
      process.stderr.write(
        'Refusing to delete usage counters without --yes. ' +
          'Run: aragon skills usage --reset --yes\n',
      );
      return EXIT_USAGE;
    }
    const removed = resetUsage();
    process.stdout.write(`Cleared ${removed} usage entr${removed === 1 ? 'y' : 'ies'}.\n`);
    return EXIT_OK;
  }

  const rows = listUsage();
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ path: getUsagePath(), skills: rows }, null, 2)}\n`);
    return EXIT_OK;
  }
  if (rows.length === 0) {
    process.stdout.write(`No skill usage recorded yet.\nFile: ${getUsagePath()}\n`);
    return EXIT_OK;
  }
  const width = Math.max(...rows.map((r) => r.name.length), 5);
  process.stdout.write(`${'skill'.padEnd(width)}  uses  last used\n`);
  for (const row of rows) {
    const stamp = row.lastUsedAt > 0 ? new Date(row.lastUsedAt).toISOString() : 'never';
    process.stdout.write(`${row.name.padEnd(width)}  ${String(row.useCount).padStart(4)}  ${stamp}\n`);
  }
  process.stdout.write(
    `\nFile: ${getUsagePath()}\n` +
      'Stored locally, never transmitted. Clear it with "aragon skills usage --reset --yes", ' +
      'or switch it off with skills.usageTracking=false.\n',
  );
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// update (§6.5)
// ---------------------------------------------------------------------------

const UPDATE_USAGE =
  'Usage: aragon skills update <name>|--all [--yes] [--force] [--dry-run]\n' +
  '       aragon skills update --check [<name>|--all]\n';

/**
 * One row of the `--all` summary, in the tense the user will read it in.
 *
 * The tense comes from the FLAG, not from the shape of the result. A successful
 * real update also carries `changedFiles`, so inferring "dry run" from its
 * presence made every genuine `--all` run report "would update" for work it had
 * already committed to disk.
 */
export function describeResult(result: UpdateResult, dryRun: boolean): string {
  if (result.ok && !result.changed) return 'up to date';
  if (result.ok && result.changed) {
    const versions =
      result.fromVersion && result.toVersion && result.fromVersion !== result.toVersion
        ? ` ${result.fromVersion} -> ${result.toVersion}`
        : '';
    return `${dryRun ? 'would update' : 'updated'}${versions}`;
  }
  return `skipped: ${result.error?.split('\n')[0] ?? result.reason ?? 'unknown'}`;
}

async function runUpdate(
  service: SkillService,
  argument: string | undefined,
  opts: SkillsCliOptions,
  cwd: string,
  version: string,
): Promise<number> {
  if (opts.check) return runUpdateCheck(service, argument, opts);

  const all = opts.all === true || argument === '--all';
  if (!all && !argument) {
    process.stderr.write(UPDATE_USAGE);
    return EXIT_USAGE;
  }

  const updateOpts = {
    cwd,
    installer: version,
    ...(opts.dryRun ? { dryRun: true } : {}),
    ...(opts.force ? { force: true } : {}),
    initiator: 'user' as const,
  };

  if (!all) {
    const result = await updateSkill(service, argument!, updateOpts);
    flushUsage();
    if (!result.ok) {
      process.stderr.write(`${result.error}\n`);
      return isHardFailure(result) ? EXIT_RUNTIME : EXIT_USAGE;
    }
    if (!result.changed) {
      process.stdout.write(`${result.name} is up to date (v${result.fromVersion}).\n`);
      return EXIT_OK;
    }
    if (opts.dryRun) {
      process.stdout.write(
        `${result.name} would update ${result.fromVersion} -> ${result.toVersion}\n` +
          (result.changedFiles ?? []).map((f) => `  ${f}\n`).join(''),
      );
      return EXIT_OK;
    }
    process.stdout.write(`Updated ${result.name} ${result.fromVersion} -> ${result.toVersion}\n`);
    return EXIT_OK;
  }

  const results = await updateAllSkills(service, updateOpts);
  flushUsage();
  if (results.length === 0) {
    process.stdout.write('No skills have an upstream to update from.\n');
    return EXIT_OK;
  }

  const width = Math.max(...results.map((r) => r.name.length), 5);
  process.stdout.write(`${'skill'.padEnd(width)}  result\n`);
  process.stdout.write(`${'-'.repeat(width)}  ${'-'.repeat(27)}\n`);
  for (const result of results) {
    process.stdout.write(
      `${result.name.padEnd(width)}  ${describeResult(result, opts.dryRun === true)}\n`,
    );
  }

  const updated = results.filter((r) => r.ok && r.changed).length;
  const unchanged = results.filter((r) => r.ok && !r.changed).length;
  const failed = results.filter(isHardFailure).length;
  const skipped = results.length - updated - unchanged - failed;
  process.stdout.write(
    `Updated ${updated}, unchanged ${unchanged}, skipped ${skipped}, failed ${failed}.\n`,
  );
  // A skill that CANNOT be updated (hand-authored, bundled, locally modified) is
  // an expected outcome of `--all`, not an error — exiting non-zero for it would
  // make the command useless in any script.
  return failed > 0 ? EXIT_RUNTIME : EXIT_OK;
}

async function runUpdateCheck(
  service: SkillService,
  argument: string | undefined,
  opts: SkillsCliOptions,
): Promise<number> {
  const all = opts.all === true || argument === '--all' || argument === undefined;
  const names = all
    ? service
        .list()
        .filter((r) => r.manifest?.source.kind === 'git')
        .map((r) => r.name)
    : [argument!];

  if (names.length === 0) {
    process.stdout.write('No git-sourced skills to check.\n');
    return EXIT_OK;
  }

  const width = Math.max(...names.map((n) => n.length), 5);
  for (const name of names) {
    const result = await checkSkillUpdate(service, name);
    const detail =
      result.status === 'outdated'
        ? ` (${(result.currentRef ?? '').slice(0, 8)} -> ${(result.remoteRef ?? '').slice(0, 8)})`
        : result.detail
        ? ` (${result.detail})`
        : '';
    process.stdout.write(`${name.padEnd(width)}  ${result.status}${detail}\n`);
  }
  return EXIT_OK;
}

function parseScope(value: string | undefined): SkillScope | undefined {
  if (value === 'user' || value === 'project') return value;
  return undefined;
}

function isApprovalError(error: string | undefined): boolean {
  return Boolean(error && error.includes('requires approval'));
}
