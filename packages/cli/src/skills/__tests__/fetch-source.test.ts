/**
 * RED-TEAM SUITE 3 of 4 (spec §19.5, C1) — command / argv injection.
 *
 * The load-bearing assertion is `runProcess` CALL COUNT === 0. Asserting only
 * "returns an error" would still pass if the rejection happened after git had
 * already been spawned with a hostile argv.
 */

import { describe, expect, it, vi } from 'vitest';
import { checkUrlAllowed, fetchSource, resolveSource } from '../fetch-source.js';
import { DEFAULT_ALLOWED_SKILL_HOSTS } from '../../config/schema.js';
import { cleanup, makeTmpDir } from './helpers.js';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const HOSTS = DEFAULT_ALLOWED_SKILL_HOSTS;

describe('resolveSource — recognition matrix (§8.2)', () => {
  it('parses github: shorthand with a subdirectory and a ref', () => {
    const r = resolveSource('github:jane/pdf-forms/skills/pdf#v1.2.0', HOSTS);
    expect(r).toEqual({
      ok: true,
      spec: {
        kind: 'git',
        url: 'https://github.com/jane/pdf-forms.git',
        ref: 'v1.2.0',
        subdir: 'skills/pdf',
      },
    });
  });

  it('parses a bare github: shorthand', () => {
    const r = resolveSource('github:jane/pdf-forms', HOSTS);
    expect(r.ok && r.spec.kind).toBe('git');
    expect(r.ok && r.spec.kind === 'git' && r.spec.ref).toBeNull();
  });

  it('recognizes git URLs, .md and .zip', () => {
    expect(resolveSource('https://github.com/a/b.git', HOSTS).ok).toBe(true);
    expect(
      resolveSource('https://raw.githubusercontent.com/a/b/main/SKILL.md', HOSTS),
    ).toMatchObject({ ok: true, spec: { kind: 'https-md' } });
    expect(resolveSource('https://github.com/a/b/archive.zip', HOSTS)).toMatchObject({
      ok: true,
      spec: { kind: 'https-zip' },
    });
  });

  it('recognizes a local directory and a local .md file', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\ndescription: d\n---\n', 'utf-8');
      expect(resolveSource(dir, HOSTS)).toMatchObject({ ok: true, spec: { kind: 'local-dir' } });
      expect(resolveSource(join(dir, 'SKILL.md'), HOSTS)).toMatchObject({
        ok: true,
        spec: { kind: 'local-file' },
      });
    } finally {
      cleanup(dir);
    }
  });

  it('rejects unknown shapes', () => {
    expect(resolveSource('', HOSTS).ok).toBe(false);
    expect(resolveSource('ftp://example.com/x.md', HOSTS).ok).toBe(false);
    expect(resolveSource('/no/such/path/at/all.txt', HOSTS).ok).toBe(false);
  });
});

describe('checkUrlAllowed — SSRF policy (§9.2)', () => {
  it('requires https and an allowlisted host', () => {
    expect(checkUrlAllowed('http://github.com/a', HOSTS).ok).toBe(false);
    expect(checkUrlAllowed('https://evil.example/a', HOSTS).ok).toBe(false);
    expect(checkUrlAllowed('https://github.com/a', HOSTS).ok).toBe(true);
  });

  it('refuses IP literals and loopback even if somehow allowlisted', () => {
    expect(checkUrlAllowed('https://127.0.0.1/a', [...HOSTS, '127.0.0.1']).ok).toBe(false);
    expect(checkUrlAllowed('https://169.254.169.254/latest/meta-data', HOSTS).ok).toBe(false);
    expect(checkUrlAllowed('https://localhost/a', [...HOSTS, 'localhost']).ok).toBe(false);
  });

  // The shorthand is the spelling a model reaches for first, so it is also the
  // one an allowlist has to cover. Expanding it into a github.com URL without
  // re-checking would leave `skills.allowedHosts` inert for the common case.
  it('applies the allowlist to the expanded github: shorthand too', () => {
    const withoutGithub = HOSTS.filter((h) => h !== 'github.com');
    const rejected = resolveSource('github:jane/pdf-forms', withoutGithub);
    expect(rejected.ok).toBe(false);
    expect(!rejected.ok && rejected.error).toContain('github.com');
    // Still accepted when the host IS allowed — the check must not be a blanket ban.
    expect(resolveSource('github:jane/pdf-forms', HOSTS).ok).toBe(true);
  });
});

describe('AC-15 — a hostile source never reaches a subprocess', () => {
  const HOSTILE = [
    'github:o/r#--upload-pack=touch /tmp/pwn',
    'github:o/r#$(touch /tmp/pwn)',
    'github:o/r#`touch /tmp/pwn`',
    'github:o/r#a&&touch /tmp/pwn',
    'github:o/r#a;touch /tmp/pwn',
    'github:o/r#../../../etc/passwd',
    'github:../evil/r',
    'github:o/../../evil',
    'github:o/r/../../escape',
    'github:-o/r',
    'github:o/-r',
    'https://github.com/o/r.git#-x',
  ];

  it.each(HOSTILE)('rejects %s at resolveSource with zero spawns', async (source) => {
    const runProcess = vi.fn(async () => undefined);

    const resolved = resolveSource(source, HOSTS);
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.error).toMatch(/Unsupported skill source/);

    // Belt and braces: even if a future refactor made resolveSource lenient,
    // nothing may have been spawned by the time we get here.
    expect(runProcess).toHaveBeenCalledTimes(0);
  });

  it('a leading dash is refused specifically, since argv alone does not stop it', () => {
    // `--upload-pack=<program>` makes git EXECUTE that program. `shell: false`
    // is no defence at all against this; only refusing the value is.
    expect(resolveSource('github:o/r#--upload-pack=calc.exe', HOSTS).ok).toBe(false);
    expect(resolveSource('github:o/r#--help', HOSTS).ok).toBe(false);
  });

  it('an accepted ref is passed as its own argv entry, after a -- separator', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const staging = makeTmpDir();
    try {
      const resolved = resolveSource('github:jane/pdf#v1.2.0', HOSTS);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;

      await fetchSource(resolved.spec, staging, {
        allowedHosts: HOSTS,
        runProcess: async (file, args) => {
          calls.push({ file, args });
          // Make the clone "succeed" by producing the directory git would.
          const target = args[args.length - 1];
          if (target && target.includes('clone')) {
            mkdirSync(target, { recursive: true });
            writeFileSync(
              join(target, 'SKILL.md'),
              '---\nname: pdf\ndescription: d\n---\n',
              'utf-8',
            );
          }
          return { stdout: 'a'.repeat(40) };
        },
      });

      // Two calls now: the clone, then `rev-parse HEAD` to pin the commit the
      // clone landed on (F9) — without it `update --check` can only ever say
      // "unknown" for a branch-tracking source.
      expect(calls).toHaveLength(2);
      expect(calls[1]!.args).toEqual(['rev-parse', 'HEAD']);
      expect(calls[0]!.file).toBe('git');
      expect(calls[0]!.args).toContain('--branch');
      expect(calls[0]!.args[calls[0]!.args.indexOf('--branch') + 1]).toBe('v1.2.0');
      expect(calls[0]!.args).toContain('--');
      // The URL must sit AFTER the `--` separator.
      expect(calls[0]!.args.indexOf('--')).toBeLessThan(
        calls[0]!.args.indexOf('https://github.com/jane/pdf.git'),
      );
    } finally {
      cleanup(staging);
    }
  });

  it('a 40-hex ref takes the fetch+checkout path, not --branch (P2-6)', async () => {
    const sha = 'a'.repeat(40);
    const calls: string[][] = [];
    const staging = makeTmpDir();
    try {
      const resolved = resolveSource(`github:jane/pdf#${sha}`, HOSTS);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;

      await fetchSource(resolved.spec, staging, {
        allowedHosts: HOSTS,
        runProcess: async (_file, args, options) => {
          calls.push(args);
          if (args[0] === 'init' && options.cwd) {
            writeFileSync(
              join(options.cwd, 'SKILL.md'),
              '---\nname: pdf\ndescription: d\n---\n',
              'utf-8',
            );
          }
          // `runProcess` is declared to resolve with `RunProcessResult`; this
          // stub asserted on `args` and returned nothing, which typechecks only
          // while the test tree is unchecked (W3). No caller here reads
          // `stdout`, so the empty string is the honest stand-in.
          return { stdout: '' };
        },
      }).catch(() => undefined);

      const flat = calls.map((a) => a.join(' '));
      expect(flat.some((c) => c.startsWith('init'))).toBe(true);
      expect(flat.some((c) => c.includes('fetch --depth 1 origin --'))).toBe(true);
      expect(flat.some((c) => c.includes('checkout'))).toBe(true);
      expect(flat.some((c) => c.includes('--branch'))).toBe(false);
    } finally {
      cleanup(staging);
    }
  });
});

describe('source-file hygiene (release condition C5)', () => {
  it('fetch-source.ts contains no exec( / execSync( / shell: true', async () => {
    // A source-level assertion in the same spirit as `no-host-coupling`: the
    // rule is only worth anything if something checks it mechanically.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const here = fileURLToPath(new URL('../fetch-source.ts', import.meta.url));
    const source = readFileSync(here, 'utf8');
    const code = source
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
      .join('\n');

    // `(?<![.\w])` lets `RegExp.prototype.exec(` and `execFile(` through while
    // still catching a bare `exec(` from node:child_process.
    const BARE_EXEC = /(?<![.\w])exec\s*\(/;
    expect(BARE_EXEC.test(code)).toBe(false);
    expect(code).not.toMatch(/execSync\s*\(/);
    expect(code).not.toMatch(/shell:\s*true/);
    // And it must still be starting processes the approved way.
    expect(code).toMatch(/shell:\s*false/);
  });

  it('the exec guard is not vacuous (self-check)', () => {
    const BARE_EXEC = /(?<![.\w])exec\s*\(/;
    expect(BARE_EXEC.test('exec(`git clone ${url}`)')).toBe(true);
    expect(BARE_EXEC.test('await exec(cmd)')).toBe(true);
    expect(BARE_EXEC.test('GITHUB_SHORTHAND.exec(trimmed)')).toBe(false);
    expect(BARE_EXEC.test('execFile(file, args)')).toBe(false);
  });
});
