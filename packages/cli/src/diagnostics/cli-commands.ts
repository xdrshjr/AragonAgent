/**
 * `aragon info` / `aragon doctor` commander wiring
 * (cli-integration-surface section 4.3).
 *
 * ASCII ONLY - `src/diagnostics/**` is inside the glyph scanner's scope.
 */

import process from 'node:process';
import type { Command } from 'commander';
import type { CliFlags } from '../config/load.js';
import { buildInfo } from './info.js';
import { runDoctorChecks, type DoctorCheck } from './doctor.js';

export function registerInfoCommand(
  program: Command,
  toFlags: (opts: Record<string, unknown>) => CliFlags,
  version: string,
): void {
  program
    .command('info')
    .description('Print what this installation supports (for wrappers and CI)')
    .option('--json', 'Machine-readable output')
    .action((opts: { json?: boolean }) => {
      const info = buildInfo(toFlags(program.opts()), version);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        [
          `aragon    ${info.cli} (core ${info.core}, node ${info.node})`,
          `schema    ${info.schemaVersion}`,
          `home      ${info.home}`,
          `config    ${info.configPath}`,
          `sessions  ${info.sessionsDir}`,
          `model     ${info.provider}/${info.model}${info.hasApiKey ? '' : '  (no API key)'}`,
          `formats   out: ${info.outputFormats.join(', ')} | in: ${info.inputFormats.join(', ')}`,
          `modes     ${info.permissionModes.join(', ')}`,
          `features  ${info.features.join(', ')}`,
          '',
        ].join('\n'),
      );
    });
}

export function registerDoctorCommand(
  program: Command,
  toFlags: (opts: Record<string, unknown>) => CliFlags,
): void {
  program
    .command('doctor')
    .description('Check that this machine is configured to run aragon (exit 0 = all clear)')
    .option('--json', 'Machine-readable output')
    .option('--probe', 'Also make one minimal API call against the configured provider')
    .action(async (opts: { json?: boolean; probe?: boolean }) => {
      const report = await runDoctorChecks(toFlags(program.opts()), {
        ...(opts.probe ? { probe: true } : {}),
      });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        for (const check of report.checks) process.stdout.write(`${renderCheck(check)}\n`);
      }
      // ONLY `fail` MOVES THE EXIT CODE. A `warn` is information; failing on one
      // would make `aragon doctor` unusable in exactly the CI job it is for.
      process.exitCode = report.ok ? 0 : 1;
    });
}

function renderCheck(check: DoctorCheck): string {
  const label = check.verdict.toUpperCase().padEnd(4);
  const head = `[${label}] ${check.name.padEnd(9)} ${check.detail}`;
  return check.remedy ? `${head}\n         ${check.remedy}` : head;
}
