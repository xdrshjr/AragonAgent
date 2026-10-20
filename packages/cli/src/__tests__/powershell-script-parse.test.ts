/**
 * Ask Windows PowerShell itself whether our script strings parse
 * (branch-terminal-powershell-fix 7.3, T-15..T-19).
 *
 * WHY THIS FILE EXISTS. Every earlier terminal test asserted on the SHAPE of a
 * string; not one of them handed that string to a parser. That is how
 * `powerShellScript` shipped without the PowerShell call operator `&` while 4,330
 * tests stayed green and the primary Windows install path - node under
 * `C:\Program Files\...`, whose path needs quoting - died on arrival (spec 2.5).
 * This is the first assertion in the repository that lets the parser vote.
 *
 * THE REVERSE ASSERTION IS THE POINT (T-18). A guard that only checks that the
 * CURRENT output parses would stay green through almost any regression, because a
 * great many wrong strings still parse. T-18 pins the OLD shape to one specific
 * parse error, so a future "let us unify the two quoting dialects" refactor has to
 * notice that it re-created the defect class rather than merely changing a string.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { powerShellQuote, powerShellScript } from '../proc/terminal-plan.js';

const POWERSHELL_EXE = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
);

/** T-19: skipping is the ONLY honest verdict on a machine without Windows PowerShell. */
const CAN_PARSE = process.platform === 'win32' && existsSync(POWERSHELL_EXE);
const suite = CAN_PARSE ? describe : describe.skip;

/**
 * Explicit timeout because there are TWO of them (R-7) and they are not the same
 * one: `spawnSync`'s 20 s bounds the child, vitest's default 5 s
 * (`vitest.config.ts` never overrides `testTimeout`) bounds this test. A cold
 * PowerShell start measures 150-400 ms here, but a loaded CI host would otherwise
 * report "the guard is broken" - and the shortest fix for that is deleting the
 * guard, which is exactly the outcome this file exists to prevent.
 */
const PARSE_TIMEOUT_MS = 30_000;

const note = ' (skipped outside Windows)';

const EXEC_WITH_SPACE = 'C:\\Program Files\\nodejs\\node.exe';
const NPM_LAUNCHER_JS =
  'C:\\Users\\jdqqj\\AppData\\Roaming\\npm\\node_modules\\@aragon-agent\\cli\\dist\\launcher.js';
const ID = 'a4k2m9';

/** PowerShell single-quoted literal: `'` becomes `''` (PowerShell's only escape). */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Ask PowerShell itself, ONCE, about every script this file cares about (D-8).
 *
 * JOINED WITH NEWLINES, NEVER WITH "; " (R-1). A `{ ; }` empty statement is
 * tolerated by a script block, but an ARGUMENT LIST is not, and neither is the gap
 * between `}` and `else`: a "; " join produces `...::ParseInput(;   $cases[$i], ...`
 * plus `... }; else { ...`, and Windows PowerShell 5.1 answers ParserError
 * `MissingEndParenthesisInMethodCall` with exit code 1 (spec appendix B-9). The
 * `run.status` check below would then throw before a single assertion ran - a
 * real-parser guard that cannot parse its own harness is the exact
 * "declared but never checked" failure this document exists to end.
 *
 * THE VERDICT IS ASCII ON PURPOSE (R-3). The console codepage on the machine this
 * defect was reported on is 936 (GBK), so `$errors[0].Message` arrives through
 * `encoding: 'utf8'` as replacement characters (appendix B-9). `col` and `id` are
 * locale independent and carry the same information, so assertions land on them
 * and NEVER on the localized message text.
 */
function parseWithPowerShell(scripts: readonly string[]): string[] {
  const program = [
    '$ErrorActionPreference = "Stop"',
    `$cases = @(${scripts.map(literal).join(', ')})`,
    'for ($i = 0; $i -lt $cases.Count; $i++) {',
    '  $errors = $null',
    '  [void][System.Management.Automation.Language.Parser]::ParseInput(',
    '    $cases[$i], [ref]$null, [ref]$errors)',
    '  if ($errors.Count -eq 0) {',
    '    Write-Output ($i.ToString() + "=ok")',
    '  } else {',
    '    Write-Output ($i.ToString() + "=error col=" +',
    '      $errors[0].Extent.StartColumnNumber + " id=" + $errors[0].ErrorId)',
    '  }',
    '}',
  ].join('\n');
  const run = spawnSync(
    POWERSHELL_EXE,
    ['-NoProfile', '-NonInteractive', '-Command', program],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true },
  );
  // A guard that cannot fail is worse than no guard: a probe that never ran must
  // abort the test, not silently pass it. `run.stderr` may be mojibake on a
  // non-UTF8 console, so it is diagnostic only and is never asserted on.
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`powershell exited ${run.status}: ${run.stderr}`);
  return run.stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.slice(line.indexOf('=') + 1));
}

/**
 * The scripts under test, in one fixed order, so a single child answers all of
 * them (six `spawnSync` calls would cost six cold PowerShell starts for the same
 * information).
 */
function scriptsUnderTest(): string[] {
  return [
    // 0 - T-15: the `bin` form, which always worked.
    powerShellScript(['aragon', '--resume', ID]),
    // 1 - T-16: the exact live shape from the bug report (`kind: 'script'`).
    powerShellScript([EXEC_WITH_SPACE, NPM_LAUNCHER_JS, '--resume', ID]),
    // 2..4 - T-17: other shapes that must stay parseable.
    powerShellScript(['C:\\PowerShell\\7\\pwsh.exe']),
    powerShellScript(['D:\\node\\node.exe', 'D:\\cli.js', '--resume', 'a'.repeat(64)]),
    powerShellScript(['@weird']),
    // 5 - T-18: the OLD implementation's real product (quoted command word, no `&`).
    // NOT `parts.join(' ')`: an unquoted `C:\Program Files\node.exe <js>` PARSES
    // fine, so that input would make the reverse assertion bite air (R-2).
    [EXEC_WITH_SPACE, NPM_LAUNCHER_JS, '--resume', ID].map(powerShellQuote).join(' '),
  ];
}

let verdicts: string[] | null = null;

/** Memoized so the whole file costs one `powershell.exe` start. */
function verdict(index: number): string {
  verdicts ??= parseWithPowerShell(scriptsUnderTest());
  const value = verdicts[index];
  if (value === undefined) throw new Error(`the parser returned no verdict for case ${index}`);
  return value;
}

suite('T-15..T-19 / D-8 / I-5: the real PowerShell parser' + note, () => {
  it(`T-15: the bin form parses${note}`, { timeout: PARSE_TIMEOUT_MS }, () => {
    expect(verdict(0)).toBe('ok');
  });

  it(`T-16: the reported win32 script shape parses${note}`, { timeout: PARSE_TIMEOUT_MS }, () => {
    // Appendix B-10 case 1: `& 'C:\Program Files\nodejs\node.exe' <launcher.js>
    // --resume a4k2m9`. Before D-1 this case was the user's ParserError.
    expect(verdict(1)).toBe('ok');
  });

  it(
    `T-17: an override path, a long id and a leading @ all parse${note}`,
    { timeout: PARSE_TIMEOUT_MS },
    () => {
      expect([verdict(2), verdict(3), verdict(4)]).toEqual(['ok', 'ok', 'ok']);
    },
  );

  it(
    `T-18: the old shape fails at column 36, so the guard has teeth${note}`,
    { timeout: PARSE_TIMEOUT_MS },
    () => {
      // Asserted to the exact column and error id, not merely `/^error /`: "it fails
      // somewhere else now" must turn this red too. Both values are locale
      // independent (R-2 / R-3 / appendix B-10 case 2).
      expect(verdict(5)).toBe('error col=36 id=UnexpectedToken');
    },
  );
});
