/**
 * The proxy-aware fallback probe (cli-auto-update-hardening H3 / section 5.4).
 *
 * ASCII ONLY - this tree is inside the glyph scanner's scope (C-2 / C-3).
 *
 * NODE'S `fetch` (undici) IGNORES `HTTP_PROXY`. v1 recorded that as R-5 and
 * accepted it: "the check fails, silently, forever". When the direct request
 * returns `null`, the check now retries ONCE through the npm this machine
 * already has, which honours `proxy`, `https-proxy`, `.npmrc` and any auth the
 * user configured.
 *
 * WE DELEGATE RATHER THAN IMPLEMENT A PROXY (D-34). We do not read `.npmrc`, we
 * do not parse `HTTP_PROXY`, and we attach credentials to nothing - D-13's "NO
 * CREDENTIALS, EVER" is untouched because we never see them. We run the command
 * the user could have typed and read one version string out of its JSON.
 *
 * `execFile` HERE, `spawn` IN `installer.ts`, AND THAT IS NOT AN INCONSISTENCY
 * (D-36 / C-20). v1's IF-3 rejected `execFile` for the installer because it
 * forwards neither `stdio` nor `detached`. This probe wants neither: it wants
 * the buffered stdout `execFile` exists to provide, and it must NOT be detached.
 * `timeout` is likewise safe here and forbidden there - a killed `npm view` has
 * written nothing, a killed `npm install -g` has left a broken global install.
 */

import { execFile, type ExecFileOptions } from 'node:child_process';
import process from 'node:process';
import { cleanInstallEnv, resolveNpmCli } from './installer.js';
import { UPDATE_LIMITS } from './limits.js';
import type { LatestManifest } from './types.js';

/** The `execFile` shape this module needs. Injectable so no test spawns npm. */
export type ExecFileImpl = (
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

export interface NpmViewDeps {
  execFileImpl?: ExecFileImpl;
  /** `null` forces the "no npm entry point" branch; `undefined` probes. */
  npmCliPath?: string | null;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * The argv this probe is allowed to build. Exported for AC-47's assertion, on
 * the `buildInstallArgs` precedent.
 *
 * `--registry` IS NOT OPTIONAL, and leaving it out was a real divergence (P1-4 /
 * D-41). The HTTP path resolves `update.registry` through `resolveRegistryUrl`;
 * `npm view` without the flag obeys whatever `.npmrc` says. The two would then
 * answer about DIFFERENT REGISTRIES - and the population where they differ is a
 * mirror-configured corporate machine, which is the same population this
 * fallback exists for. The `registry` passed in is the already-resolved string
 * `runCheck` computed, so the two probes describe one registry by construction.
 *
 * Auth is unaffected: `--registry` selects a URL, and npm still applies whatever
 * `.npmrc` credentials are scoped to it. We neither read nor forward any (D-13).
 */
export function buildNpmViewArgs(
  npmCliJs: string,
  packageName: string,
  distTag: string,
  registry: string,
): string[] {
  return [
    npmCliJs,
    'view',
    `${packageName}@${distTag}`,
    '--json',
    '--loglevel=error',
    `--registry=${registry}`,
  ];
}

/**
 * Normalise `npm view`'s object into the SAME shape `fetchLatestManifest`
 * returns, so `decideUpdate` cannot tell the two sources apart.
 *
 * `npm view pkg@tag --json` on a dist-tag yields one object. An ARRAY comes back
 * for a range, which we never send - but npm is not ours, so take the last
 * element rather than failing the whole probe on a shape we did not ask for.
 */
function normalise(parsed: unknown): LatestManifest | null {
  const one = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
  if (!one || typeof one !== 'object') return null;
  const doc = one as Partial<LatestManifest>;
  if (typeof doc.name !== 'string' || typeof doc.version !== 'string') return null;
  return {
    name: doc.name,
    version: doc.version,
    ...(doc.engines && typeof doc.engines === 'object'
      ? { engines: { ...(typeof doc.engines.node === 'string' ? { node: doc.engines.node } : {}) } }
      : {}),
    // Present ONLY when the version is deprecated. npm writes a string, but
    // `true` appears in the wild; both mean "do not auto-install this".
    ...(doc.deprecated !== undefined ? { deprecated: String(doc.deprecated) } : {}),
  };
}

/**
 * Ask the machine's own npm what the dist-tag points at, or `null`.
 *
 * NEVER THROWS - the same contract as `fetchLatestManifest`, for the same
 * reason: the only caller is a background timer whose entire contract is that
 * the user does not find out. Any non-zero exit, any timeout, any unparseable
 * stdout and a `resolveNpmCli()` of `null` all resolve to `null`.
 *
 * NO BARE-`npm`-ON-PATH FALLBACK, for the reason `installer.ts` already gives:
 * on Windows that resolves to `npm.cmd`, which U-2 forbids.
 */
export function fetchLatestViaNpm(
  registry: string,
  packageName: string,
  distTag: string,
  deps: NpmViewDeps = {},
): Promise<LatestManifest | null> {
  return new Promise<LatestManifest | null>((settle) => {
    const npmCliJs = deps.npmCliPath !== undefined ? deps.npmCliPath : resolveNpmCli();
    if (!npmCliJs) {
      settle(null);
      return;
    }

    const run = deps.execFileImpl ?? (execFile as unknown as ExecFileImpl);
    const options: ExecFileOptions = {
      // C-7, spelled out rather than inherited: this argv carries a package name
      // read from a manifest on disk and a registry URL from config.
      shell: false,
      windowsHide: true,
      timeout: deps.timeoutMs ?? UPDATE_LIMITS.npmViewTimeoutMs,
      maxBuffer: UPDATE_LIMITS.manifestMaxBytes,
      env: cleanInstallEnv(deps.env ?? process.env),
    };

    let settled = false;
    const finish = (value: LatestManifest | null): void => {
      if (settled) return;
      settled = true;
      settle(value);
    };

    try {
      run(
        process.execPath,
        buildNpmViewArgs(npmCliJs, packageName, distTag, registry),
        options,
        (error, stdout) => {
          if (error) {
            finish(null);
            return;
          }
          try {
            finish(normalise(JSON.parse(String(stdout))));
          } catch {
            finish(null);
          }
        },
      );
    } catch {
      // `execFile` can throw synchronously on a bad argv or a missing binary.
      finish(null);
    }
  });
}
