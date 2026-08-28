/**
 * Install-source identification and fetching (spec §8.2 / §9.2).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * `skill_install.source` IS A MODEL PARAMETER. Treat it as hostile input.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Four rules are MUST (§8.2.1 / D20). Breaking any one of them is a shell or
 * argv injection, not a style problem:
 *
 *   1. External processes are started with `execFile(cmd, argv[], {shell:false})`
 *      only. No `exec()`, no `execSync()`, no `shell: true`, no string
 *      concatenation of a command line. `tools/bash-tool.ts` DOES use
 *      `shell: true` — that is the bash tool's deliberate purpose and is NOT a
 *      precedent for this module. Copy `builtins.ts::copyToClipboard` instead.
 *
 *   2. Validate BEFORE building argv. `resolveSource()` is pure and spawns
 *      nothing; anything that fails here never reaches a subprocess.
 *
 *   3. Reject a leading `-` on every model-controlled fragment. This matters
 *      even with a pure argv array: `git clone --branch --upload-pack=calc.exe`
 *      makes git execute an arbitrary program. `shell: false` does not help.
 *      The whitelists below already force an alphanumeric first character; the
 *      explicit check is a second, separately-tested statement of intent.
 *
 *   4. Never let git prompt. A private repo would otherwise hang a headless
 *      install forever waiting on a credential prompt nobody can see.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import type { SkillManifestSource } from '@aragon-agent/core/skills';
import { extractZip, ARCHIVE_MAX_DOWNLOAD_BYTES } from './archive.js';
import { isDirectory } from './paths.js';

const execFileAsync = promisify(execFile);

export const HTTP_TIMEOUT_MS = 15_000;
export const GIT_TIMEOUT_MS = 120_000;
export const MAX_REDIRECTS = 3;
export const SKILL_MD_DOWNLOAD_MAX_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Whitelists (§8.2.1 rule 2)
// ---------------------------------------------------------------------------

const OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SUBDIR = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

function rejectsDashPrefix(value: string): boolean {
  return value.startsWith('-');
}

function validOwnerOrRepo(value: string): boolean {
  if (value === '.' || value === '..') return false;
  if (rejectsDashPrefix(value)) return false;
  return OWNER_REPO.test(value);
}

function validRef(value: string): boolean {
  if (rejectsDashPrefix(value)) return false;
  if (value.includes('..')) return false;
  if (value.endsWith('/') || value.endsWith('.')) return false;
  return REF.test(value);
}

function validSubdir(value: string): boolean {
  if (rejectsDashPrefix(value)) return false;
  if (value.includes('..')) return false;
  if (value.startsWith('/')) return false;
  return SUBDIR.test(value);
}

// ---------------------------------------------------------------------------
// Host policy (§9.2 — SSRF guard)
// ---------------------------------------------------------------------------

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** `https:` only, hostname on the allowlist, never an IP literal or loopback. */
export function checkUrlAllowed(raw: string, allowedHosts: string[]): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `not a valid URL: ${raw}` };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, error: `only https:// sources are allowed (got ${url.protocol}//)` };
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || IPV4.test(host) || host.includes(':')) {
    return { ok: false, error: `IP literals and localhost are not allowed: ${host}` };
  }
  if (!allowedHosts.map((h) => h.toLowerCase()).includes(host)) {
    return {
      ok: false,
      error: `host "${host}" is not in skills.allowedHosts (${allowedHosts.join(', ')})`,
    };
  }
  return { ok: true, url };
}

// ---------------------------------------------------------------------------
// resolveSource — PURE. Spawns nothing, touches no network.
// ---------------------------------------------------------------------------

export type SourceSpec =
  | { kind: 'local-dir'; path: string }
  | { kind: 'local-file'; path: string }
  | { kind: 'git'; url: string; ref: string | null; subdir: string | null }
  | { kind: 'https-md'; url: string }
  | { kind: 'https-zip'; url: string };

export type ResolveResult = { ok: true; spec: SourceSpec } | { ok: false; error: string };

const UNSUPPORTED = (source: string): ResolveResult => ({
  ok: false,
  error: `Unsupported skill source: ${source}`,
});

const GITHUB_SHORTHAND = /^github:(.+)$/;
const GIT_HOSTS = new Set(['github.com', 'gitlab.com']);

/**
 * Classify and validate an install source.
 *
 * Every rejection path returns before any subprocess or socket exists — that
 * property is what AC-15 asserts (mocked `execFile`, call count 0).
 */
export function resolveSource(source: string, allowedHosts: string[]): ResolveResult {
  const trimmed = source.trim();
  if (trimmed.length === 0) return UNSUPPORTED(source);

  // 1. `github:owner/repo[/subdir][#ref]`
  const shorthand = GITHUB_SHORTHAND.exec(trimmed);
  if (shorthand) return resolveGithubShorthand(shorthand[1]!, trimmed, allowedHosts);

  // 2. Local paths — checked before URLs so a Windows path is never a URL.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !trimmed.startsWith('git+')) {
    if (isDirectory(trimmed)) return { ok: true, spec: { kind: 'local-dir', path: trimmed } };
    if (/\.md$/i.test(trimmed)) return { ok: true, spec: { kind: 'local-file', path: trimmed } };
    return UNSUPPORTED(source);
  }

  // 3. Explicit git URL.
  const isGitPlus = trimmed.startsWith('git+');
  const bare = isGitPlus ? trimmed.slice(4) : trimmed;

  const [beforeHash, afterHash] = splitOnce(bare, '#');
  const ref = afterHash ?? null;
  if (ref !== null && !validRef(ref)) {
    return { ok: false, error: `Unsupported skill source: invalid ref "${ref}"` };
  }

  const checked = checkUrlAllowed(beforeHash, allowedHosts);
  if (!checked.ok) return { ok: false, error: `Unsupported skill source: ${checked.error}` };
  const url = checked.url;

  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  const looksGit =
    isGitPlus ||
    url.pathname.endsWith('.git') ||
    (GIT_HOSTS.has(url.hostname.toLowerCase()) &&
      segments.length >= 2 &&
      !/\.(md|zip|tar\.gz|tgz)$/i.test(url.pathname));

  if (looksGit) {
    if (segments.length < 2) return UNSUPPORTED(source);
    const owner = segments[0]!;
    const repo = segments[1]!.replace(/\.git$/, '');
    if (!validOwnerOrRepo(owner) || !validOwnerOrRepo(repo)) {
      return { ok: false, error: `Unsupported skill source: invalid owner/repo in ${source}` };
    }
    const subdir = segments.slice(2).join('/');
    if (subdir.length > 0 && !validSubdir(subdir)) {
      return { ok: false, error: `Unsupported skill source: invalid subdirectory "${subdir}"` };
    }
    return {
      ok: true,
      spec: {
        kind: 'git',
        url: `https://${url.hostname}/${owner}/${repo}.git`,
        ref,
        subdir: subdir.length > 0 ? subdir : null,
      },
    };
  }

  if (/\.md$/i.test(url.pathname)) return { ok: true, spec: { kind: 'https-md', url: url.toString() } };
  if (/\.zip$/i.test(url.pathname)) return { ok: true, spec: { kind: 'https-zip', url: url.toString() } };
  return UNSUPPORTED(source);
}

/**
 * Expand `github:owner/repo[/subdir][#ref]`.
 *
 * The synthesized URL goes through the SAME host allowlist as an explicit one.
 * The shorthand is sugar, not a second policy: without this check a user who
 * narrowed `skills.allowedHosts` to an internal mirror would still see the model
 * reach github.com, and the setting they trusted to stop that would be silently
 * inert for the shortest, most likely-to-be-used spelling.
 */
function resolveGithubShorthand(
  rest: string,
  original: string,
  allowedHosts: string[],
): ResolveResult {
  const [pathPart, refPart] = splitOnce(rest, '#');
  const ref = refPart ?? null;
  if (ref !== null && !validRef(ref)) {
    return { ok: false, error: `Unsupported skill source: invalid ref "${ref}"` };
  }
  const segments = pathPart.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) return UNSUPPORTED(original);
  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/, '');
  if (!validOwnerOrRepo(owner) || !validOwnerOrRepo(repo)) {
    return { ok: false, error: `Unsupported skill source: invalid owner/repo in ${original}` };
  }
  const subdir = segments.slice(2).join('/');
  if (subdir.length > 0 && !validSubdir(subdir)) {
    return { ok: false, error: `Unsupported skill source: invalid subdirectory "${subdir}"` };
  }
  const checked = checkUrlAllowed(`https://github.com/${owner}/${repo}`, allowedHosts);
  if (!checked.ok) return { ok: false, error: `Unsupported skill source: ${checked.error}` };
  return {
    ok: true,
    spec: {
      kind: 'git',
      url: `https://github.com/${owner}/${repo}.git`,
      ref,
      subdir: subdir.length > 0 ? subdir : null,
    },
  };
}

function splitOnce(value: string, sep: string): [string, string | undefined] {
  const idx = value.indexOf(sep);
  if (idx === -1) return [value, undefined];
  return [value.slice(0, idx), value.slice(idx + 1)];
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export interface RunProcessResult {
  stdout: string;
}

export interface FetchDeps {
  allowedHosts: string[];
  /** Injectable so tests can assert the subprocess count without spawning git. */
  runProcess?: (
    file: string,
    args: string[],
    options: { cwd?: string },
  ) => Promise<RunProcessResult>;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

export interface FetchOutcome {
  /** Directory holding the fetched skill content. */
  dir: string;
  source: SkillManifestSource;
}

async function defaultRunProcess(
  file: string,
  args: string[],
  options: { cwd?: string },
): Promise<RunProcessResult> {
  const { stdout } = await execFileAsync(file, args, {
    // Rule 1: argv array, never a shell.
    shell: false,
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    // Rule 4: a credential prompt in a non-interactive install is a hang, not a
    // question — the user would just see the CLI freeze with no explanation.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never' },
  });
  return { stdout };
}

/** Fetch a resolved source into `stagingDir`, returning where the content landed. */
export async function fetchSource(
  spec: SourceSpec,
  stagingDir: string,
  deps: FetchDeps,
): Promise<FetchOutcome> {
  await mkdir(stagingDir, { recursive: true });

  switch (spec.kind) {
    case 'local-dir':
      return {
        dir: spec.path,
        source: { kind: 'local-dir', url: spec.path, ref: null, subdir: null },
      };

    // Single-file sources land in a dedicated subdirectory, never in
    // `stagingDir` itself: the installer copies whatever directory we return
    // into `<stagingDir>/content`, and returning the staging root would make
    // that a copy of a directory into its own child.
    case 'local-file': {
      const dir = join(stagingDir, 'single');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), await readFile(spec.path, 'utf-8'), 'utf-8');
      return { dir, source: { kind: 'local-file', url: spec.path, ref: null, subdir: null } };
    }

    case 'https-md': {
      const dir = join(stagingDir, 'single');
      await mkdir(dir, { recursive: true });
      const body = await downloadText(spec.url, SKILL_MD_DOWNLOAD_MAX_BYTES, deps);
      await writeFile(join(dir, 'SKILL.md'), body, 'utf-8');
      return { dir, source: { kind: 'https-md', url: spec.url, ref: null, subdir: null } };
    }

    case 'https-zip': {
      const buffer = await downloadBuffer(spec.url, ARCHIVE_MAX_DOWNLOAD_BYTES, deps);
      const extracted = join(stagingDir, 'unpacked');
      await extractZip(buffer, extracted);
      return {
        dir: await descendToSkillRoot(extracted),
        source: { kind: 'https-zip', url: spec.url, ref: null, subdir: null },
      };
    }

    case 'git': {
      const cloneDir = join(stagingDir, 'clone');
      await gitClone(spec, cloneDir, deps);
      const root = spec.subdir ? join(cloneDir, spec.subdir) : cloneDir;
      if (!isDirectory(root)) {
        throw new Error(`subdirectory "${spec.subdir}" not found in the repository`);
      }
      // Read the commit BEFORE dropping .git — after the rm there is nothing
      // left to ask. A branch name alone cannot answer "is the remote ahead?",
      // which is what `update --check` needs (F9).
      const resolvedRef = await readHeadSha(cloneDir, deps);
      // Drop the VCS metadata: it is not part of the skill and would bloat the
      // manifest and the size budget by an order of magnitude.
      await rm(join(cloneDir, '.git'), { recursive: true, force: true });
      return {
        dir: await descendToSkillRoot(root),
        source: { kind: 'git', url: spec.url, ref: spec.ref, subdir: spec.subdir, resolvedRef },
      };
    }
  }
}

/**
 * Clone at a single revision.
 *
 * `--branch` accepts branches and tags but NOT a bare commit SHA (P2-6), so a
 * sha-shaped ref takes the init+fetch+checkout path instead of failing with a
 * confusing "Remote branch not found".
 */
async function gitClone(
  spec: Extract<SourceSpec, { kind: 'git' }>,
  cloneDir: string,
  deps: FetchDeps,
): Promise<void> {
  const run = deps.runProcess ?? defaultRunProcess;
  const ref = spec.ref;

  if (ref && COMMIT_SHA.test(ref)) {
    await mkdir(cloneDir, { recursive: true });
    await run('git', ['init', '--quiet'], { cwd: cloneDir });
    await run('git', ['remote', 'add', 'origin', '--', spec.url], { cwd: cloneDir });
    await run('git', ['fetch', '--depth', '1', 'origin', '--', ref], { cwd: cloneDir });
    await run('git', ['checkout', '--quiet', 'FETCH_HEAD'], { cwd: cloneDir });
    return;
  }

  // `--` separates options from operands so a hostile URL can never be read as
  // a flag, even if every check above were somehow bypassed.
  const args = ['clone', '--depth', '1', '--quiet'];
  if (ref) args.push('--branch', ref);
  args.push('--', spec.url, cloneDir);
  await run('git', args, {});
}

/**
 * Ask a remote for the sha behind `ref`, without downloading anything.
 *
 * Subject to the SAME four rules as every other subprocess here (D20): argv
 * array, `shell:false`, no leading `-` on any model-influenced fragment, and no
 * credential prompt. The caller must have re-validated the URL against the host
 * allowlist first — this function does not do policy.
 *
 * Returns `null` for "cannot tell", which is the honest answer for a source
 * git cannot reach, an unmatched ref, or a non-sha reply.
 */
export async function gitLsRemote(
  url: string,
  ref: string | null,
  deps: FetchDeps,
): Promise<string | null> {
  if (ref !== null && !validRef(ref)) return null;
  const run = deps.runProcess ?? defaultRunProcess;
  const args = ['ls-remote', '--exit-code', '--', url];
  if (ref) args.push(ref);
  try {
    const { stdout } = await run('git', args, {});
    const sha = (stdout ?? '').trim().split(/\s+/)[0] ?? '';
    return COMMIT_SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * The commit the clone actually landed on, or `null` if git would not say.
 *
 * Provenance is an OPTIMISATION here, never a precondition: a shallow clone
 * that succeeded is a valid install even if `rev-parse` fails, so this swallows
 * its errors instead of failing the install over a nicety.
 */
async function readHeadSha(cloneDir: string, deps: FetchDeps): Promise<string | null> {
  const run = deps.runProcess ?? defaultRunProcess;
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: cloneDir });
    const sha = (stdout ?? '').trim();
    return COMMIT_SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * A repo whose root has no SKILL.md but exactly one subdirectory that does is
 * the common `repo/skill-name/SKILL.md` layout — descend into it. Ambiguity
 * (several candidates) is reported so the user can name the subdirectory.
 */
async function descendToSkillRoot(dir: string): Promise<string> {
  const { readdirSync, existsSync } = await import('node:fs');
  if (existsSync(join(dir, 'SKILL.md'))) return dir;
  const candidates = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .filter((e) => existsSync(join(dir, e.name, 'SKILL.md')))
    .map((e) => e.name);
  if (candidates.length === 1) return join(dir, candidates[0]!);
  if (candidates.length > 1) {
    throw new Error(
      `the source contains ${candidates.length} skills (${candidates.join(', ')}); ` +
        'point at one of them explicitly',
    );
  }
  return dir;
}

// ---------------------------------------------------------------------------
// HTTP with a byte ceiling and redirect re-checking
// ---------------------------------------------------------------------------

async function httpGet(url: string, deps: FetchDeps): Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Re-check EVERY hop: an allowlisted host that 302s to an internal address
    // would otherwise be a free SSRF.
    const allowed = checkUrlAllowed(current, deps.allowedHosts);
    if (!allowed.ok) throw new Error(allowed.error);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let response: Response;
    try {
      response = await doFetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': deps.userAgent ?? 'aragon-agent-cli' },
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`redirect without a Location header (${response.status})`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${current}`);
    return response;
  }
  throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
}

/** Read a response body, aborting as soon as it passes `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new Error(`response is ${declared} bytes (max ${maxBytes})`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const body = response.body;
  if (!body) return Buffer.alloc(0);
  // Content-Length is advisory; the running total is the real gate.
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`response exceeded ${maxBytes} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function downloadText(url: string, maxBytes: number, deps: FetchDeps): Promise<string> {
  return (await readCapped(await httpGet(url, deps), maxBytes)).toString('utf-8');
}

async function downloadBuffer(url: string, maxBytes: number, deps: FetchDeps): Promise<Buffer> {
  return readCapped(await httpGet(url, deps), maxBytes);
}

