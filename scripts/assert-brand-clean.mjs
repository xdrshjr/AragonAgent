#!/usr/bin/env node
/**
 * Brand gate (C1).
 *
 * Turns the previously-manual acceptance item "both tarballs carry zero legacy
 * brand, README included" into a machine verdict wired into the publish path
 * (`Invoke-ReleaseChecks` -> `npm run verify:brand`).
 *
 * It does NOT unpack a tarball: the subproject has no tar parser, and pulling
 * one in for a single check is not worth it. `npm pack --dry-run --json` already
 * answers the only question that matters — WHICH FILES GO INTO THE TARBALL — and
 * reading those same files off disk is byte-identical to reading them out of the
 * archive. Deriving the list from npm itself (rather than a hand-maintained path
 * list) is what keeps this gate from silently going out of date.
 *
 * Exit 0 = clean; exit 1 = at least one hit, or the scan could not be performed.
 * "Scanned nothing" and "scanned and found nothing" must never share an exit
 * code, because the second is a release gate and the first is a broken gate.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

export const WORKSPACES = ['packages/core', 'packages/cli'];

/**
 * The one registry every tool in this directory talks to.
 *
 * Measured, not fastidiousness: this machine's default registry is a mirror, and
 * mirrors 404 the account-side endpoints wholesale. Control experiment —
 * `npm access list packages @argon-agent`, an owned read-write scope, returns
 * E404 against the default mirror and `read-write` against npmjs.org. Without a
 * pin, "the scope does not exist" cannot be told apart from "the mirror does not
 * serve that endpoint".
 *
 * The rule is deliberately blanket — EVERY npm call in these three scripts pins
 * it, including `npm pack --dry-run`, which is purely local and provably
 * unaffected (verified: identical stdout with and without the flag). A rule with
 * no exceptions is far harder to erode than one that has to be re-argued per
 * call site, and `release-preflight.test.mjs::R3` asserts it exhaustively.
 */
export const NPMJS = 'https://registry.npmjs.org/';

/**
 * Files that are ALLOWED to mention the legacy brand, exhaustively.
 *
 * Adding a fifth entry is a design change: record the reason in
 * `docs/plans/aragon-agent-npm-release-cutover/spec.md` first. `T8` in
 * `scripts/tests/assert-brand-clean.test.mjs` asserts this table verbatim so the
 * whitelist cannot grow by accident.
 *
 * `README.md` is deliberately absent from every list — the requirement named it
 * explicitly, so it has to come out at zero hits.
 */
export const ALLOWED = {
  // The 0.2.0 Breaking entry has to spell out the old package name.
  'packages/core': ['CHANGELOG.md'],
  'packages/cli': [
    // Same, plus the 11 ARGON_* variable names it retires.
    'CHANGELOG.md',
    // The user-state migration module holds the old directory name by definition.
    'dist/config/migrate-legacy-state.js',
    // `tsconfig` has no `sourceMap`, so there is no matching `.js.map` to allow.
    'dist/config/migrate-legacy-state.d.ts',
  ],
};

// Captures the whole identifier around a hit so the benign rules below can look
// at its neighbours instead of at bare 'argon'.
const TOKEN_SOURCE = '[A-Za-z0-9_]*argon[A-Za-z0-9_]*';

// jargon / jaRgon ... -> a letter in front  -> benign (the host really does ship
//                                              "Avoid jargon" prose)
// argon2 / argon2id   -> a digit behind     -> benign (password hash, other lane)
// argon-agent / ARGON_MODEL / ArgonAgent    -> legacy brand, report it
//
// The load-bearing premise, proved in the rename spec and kept true by the G0
// guard: 'aragon' does not contain the substring 'argon' (a-r-a-g-o-n), so the
// new brand can never trip its own gate.
const BENIGN = /^(?:[A-Za-z]+argon[A-Za-z0-9_]*|argon\d[A-Za-z0-9_]*)$/i;

const EXCERPT_RADIUS = 40;
const BINARY_SNIFF_BYTES = 8192;

/**
 * @param {string} text
 * @returns {Array<{ line: number, column: number, token: string, excerpt: string }>}
 */
export function findLegacyBrandHits(text) {
  const hits = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // A fresh regex per line: a shared /g/ instance carries `lastIndex` between
    // calls, which would make results depend on call order.
    const matcher = new RegExp(TOKEN_SOURCE, 'gi');
    let match;
    while ((match = matcher.exec(line)) !== null) {
      const token = match[0];
      if (BENIGN.test(token)) {
        continue;
      }
      hits.push({
        line: index + 1,
        column: match.index + 1,
        token,
        excerpt: buildExcerpt(line, match.index),
      });
    }
  }
  return hits;
}

function buildExcerpt(line, index) {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(line.length, index + EXCERPT_RADIUS);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < line.length ? '...' : '';
  return `${prefix}${line.slice(start, end)}${suffix}`;
}

const SHELL_METACHARACTERS = /[\s&|<>^()"]/;

function quoteForShell(argument) {
  return SHELL_METACHARACTERS.test(argument) ? `"${argument.replace(/"/g, '\\"')}"` : argument;
}

/**
 * Resolution order: the path npm hands us > a shell fallback > fail fast.
 *
 * Both intuitive spellings are unusable on this project's primary platform
 * (measured on Node v22.18.0 / npm 10.9.3, Windows):
 *   spawnSync('npm', args)      -> ENOENT
 *   spawnSync('npm.cmd', args)  -> EINVAL  (Node's CVE-2024-27980 fix refuses to
 *                                           spawn .cmd/.bat without a shell)
 * `npm_execpath` only exists under `npm run`, and `node scripts/<tool>.mjs` is a
 * supported entry point, so both paths have to work.
 */
export function createNpmRunner(cwd) {
  const viaNpm = process.env.npm_execpath;
  if (viaNpm && viaNpm.endsWith('.js')) {
    return (args, options = {}) =>
      spawnSync(process.execPath, [viaNpm, ...args], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        ...options,
      });
  }
  return (args, options = {}) =>
    spawnSync('npm', args.map(quoteForShell), {
      cwd,
      encoding: 'utf8',
      shell: true,
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
}

/**
 * npm interleaves notices on stderr, so stdout is normally clean JSON. The
 * fallback mirrors `publish-latest.ps1::ConvertFrom-NpmJsonText` (first bracket
 * to last bracket) rather than stripping notices with a regex.
 */
export function parseNpmJson(text) {
  if (!text || text.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
    if (start < 0 || end < start) {
      return null;
    }
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function fail(message) {
  console.error(`[assert-brand-clean] ${message}`);
  process.exit(1);
}

/**
 * The two `npm pack --dry-run` calls here duplicate the two already in
 * `Invoke-ReleaseChecks` (four per release). Each costs a few hundred
 * milliseconds, which is not worth a cache — and they are the gate's only source
 * of an authoritative file list, so they must not be swapped for the `files`
 * field. Noted so nobody later "optimises" them away.
 */
function collectPackedFiles(runNpm, workspace) {
  const packed = runNpm(['pack', '-w', workspace, '--dry-run', '--json', '--registry', NPMJS]);
  if (packed.status !== 0) {
    fail(
      `npm pack --dry-run failed for ${workspace} ` +
        `(status=${packed.status}, error=${packed.error?.code ?? 'none'}): ${packed.stderr ?? ''}`,
    );
  }
  const payload = parseNpmJson(packed.stdout);
  if (!Array.isArray(payload) || !payload[0] || !Array.isArray(payload[0].files)) {
    fail(`npm pack --dry-run returned no file list for ${workspace}: ${packed.stdout ?? ''}`);
  }
  return payload[0].files;
}

function main() {
  const wantsJson = process.argv.includes('--json');
  const runNpm = createNpmRunner(repoRoot);
  const offenders = [];
  let packed = 0;
  let scanned = 0;
  let allowlisted = 0;
  let skippedBinary = 0;

  for (const workspace of WORKSPACES) {
    const allowed = ALLOWED[workspace] ?? [];
    for (const entry of collectPackedFiles(runNpm, workspace)) {
      const relativePath = entry.path;
      packed += 1;
      if (allowed.includes(relativePath)) {
        allowlisted += 1;
        continue;
      }
      const absolutePath = join(repoRoot, workspace, relativePath);
      let buffer;
      try {
        buffer = readFileSync(absolutePath);
      } catch (error) {
        fail(`npm listed ${workspace}/${relativePath} for packing but it cannot be read: ${error.message}`);
      }
      if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0x00)) {
        skippedBinary += 1;
        continue;
      }
      scanned += 1;
      for (const hit of findLegacyBrandHits(buffer.toString('utf8'))) {
        offenders.push({ workspace, file: relativePath, ...hit });
      }
    }
  }

  if (wantsJson) {
    const stream = offenders.length > 0 ? console.error : console.log;
    stream(
      JSON.stringify(
        { ok: offenders.length === 0, packed, scanned, allowlisted, skippedBinary, offenders },
        null,
        2,
      ),
    );
  } else if (offenders.length > 0) {
    console.error('[assert-brand-clean] BLOCKED: legacy brand found in files that would be published:');
    console.error('');
    for (const offender of offenders) {
      console.error(`  ${offender.workspace}/${offender.file}:${offender.line}:${offender.column}  ${offender.token}`);
      console.error(`      ${offender.excerpt}`);
    }
    console.error('');
    console.error(`${offenders.length} hit(s). Fix them, rebuild, and re-run: npm run verify:brand`);
  }

  if (offenders.length > 0) {
    process.exit(1);
  }
  if (!wantsJson) {
    console.log(
      `[assert-brand-clean] OK — ${scanned} files scanned across ${WORKSPACES.length} workspaces ` +
        `(${packed} packed, ${allowlisted} allowlisted, ${skippedBinary} binary), 0 legacy-brand hits.`,
    );
  }
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main();
}
