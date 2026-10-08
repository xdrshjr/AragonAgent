/**
 * Loader for unrestricted-mode instruction packages.
 *
 * A package is one Markdown file, byte-stable, validated against a sha256
 * manifest when one is present - the same discipline the gpt-instruct
 * archives use (byte-identical prompt + published digest), so a transcript
 * that names a package name and digest pins exactly one prompt body.
 *
 * Directory layout (default `<aragon home>/unrestricted`, override with
 * `ARAGON_UNRESTRICTED_DIR`):
 *
 *   some-package.md        any number of packages
 *   manifest.json          optional:
 *     { "schema": 1, "default": "<name>",
 *       "packages": { "<name>": { "file": "<file>.md",
 *                                  "sha256": "<64 hex>", "bytes": <n> } } }
 *
 * Without a manifest the SINGLE .md file in the directory is used; more than
 * one without a manifest is ambiguous and refused rather than guessed. A
 * manifest without a `default` is likewise refused for the same reason.
 *
 * The loader is total: every failure is a typed value, never a throw, so the
 * controller can refuse mode entry (and say why) instead of catching.
 *
 * ASCII ONLY - `unrestricted/` is inside the glyph scanner's scope.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { PathLike } from 'node:fs';
import { MAX_PACKAGE_BYTES, MAX_PACKAGES, UNRESTRICTED_DIR_ENV } from './limits.js';

/** One validated instruction package. `sha256` pins the exact bytes. */
export interface UnrestrictedPackage {
  name: string;
  body: string;
  sha256: string;
  bytes: number;
}

export type UnrestrictedLoadFailure =
  | { kind: 'no_dir' }
  | { kind: 'no_package' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'too_many'; count: number }
  | { kind: 'too_large'; name: string; bytes: number }
  | { kind: 'hash_mismatch'; name: string; expected: string; actual: string }
  | { kind: 'bad_manifest' }
  | { kind: 'no_default' }
  | { kind: 'unknown_default'; name: string }
  | { kind: 'unreadable'; name: string };

export type UnrestrictedLoadResult =
  | { ok: true; pkg: UnrestrictedPackage }
  | { ok: false; failure: UnrestrictedLoadFailure };

interface ManifestEntry {
  file?: unknown;
  sha256?: unknown;
}

interface ParsedManifest {
  default?: unknown;
  packages?: unknown;
}

/** Resolve the package directory: env override, else `<home>/unrestricted`. */
export function defaultUnrestrictedDir(home: string, env: Record<string, string | undefined> = process.env): string {
  const override = env[UNRESTRICTED_DIR_ENV];
  if (override && override.trim().length > 0) return override;
  return `${home.replace(/[\\/]+$/, '')}/unrestricted`;
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Load the active package from `dir`.
 *
 * Sync on purpose: it runs once, at controller construction, and every caller
 * (mode toggle, `/plan status` surfaces) needs a yes/no answer immediately.
 */
export function loadUnrestrictedPackage(dir: PathLike): UnrestrictedLoadResult {
  if (!existsSync(dir)) return { ok: false, failure: { kind: 'no_dir' } };

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { ok: false, failure: { kind: 'no_dir' } };
  }

  const mdFiles = entries.filter((name) => name.toLowerCase().endsWith('.md'));
  if (mdFiles.length === 0) return { ok: false, failure: { kind: 'no_package' } };

  const manifestPath = `${String(dir).replace(/[\\/]+$/, '')}/manifest.json`;
  if (!existsSync(manifestPath)) {
    if (mdFiles.length > 1) return { ok: false, failure: { kind: 'ambiguous', count: mdFiles.length } };
    return readPackage(String(dir), mdFiles[0]!, undefined);
  }

  let manifest: ParsedManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ParsedManifest;
  } catch {
    return { ok: false, failure: { kind: 'bad_manifest' } };
  }

  const packages = manifest.packages;
  if (packages === undefined || typeof packages !== 'object' || packages === null) {
    return { ok: false, failure: { kind: 'bad_manifest' } };
  }
  const declared = Object.keys(packages as Record<string, ManifestEntry>);
  if (declared.length === 0) return { ok: false, failure: { kind: 'no_package' } };
  if (declared.length > MAX_PACKAGES) {
    return { ok: false, failure: { kind: 'too_many', count: declared.length } };
  }

  const defaultName = manifest.default;
  if (typeof defaultName !== 'string' || defaultName.length === 0) {
    return { ok: false, failure: { kind: 'no_default' } };
  }
  const entry = (packages as Record<string, ManifestEntry>)[defaultName];
  if (entry === undefined || typeof entry !== 'object' || entry === null) {
    return { ok: false, failure: { kind: 'unknown_default', name: defaultName } };
  }
  if (typeof entry.file !== 'string' || entry.file.length === 0) {
    return { ok: false, failure: { kind: 'bad_manifest' } };
  }

  return readPackage(String(dir), entry.file, entry);
}

function readPackage(
  dir: string,
  file: string,
  entry: ManifestEntry | undefined,
): UnrestrictedLoadResult {
  const name = file.replace(/\.md$/i, '');
  const path = `${dir.replace(/[\\/]+$/, '')}/${file}`;

  let bytes: number;
  try {
    bytes = statSync(path).size;
  } catch {
    return { ok: false, failure: { kind: 'unreadable', name } };
  }
  if (bytes > MAX_PACKAGE_BYTES) {
    return { ok: false, failure: { kind: 'too_large', name, bytes } };
  }

  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, failure: { kind: 'unreadable', name } };
  }

  const actual = sha256Hex(body);
  if (typeof entry?.sha256 === 'string' && entry.sha256.length > 0 && entry.sha256 !== actual) {
    return { ok: false, failure: { kind: 'hash_mismatch', name, expected: entry.sha256, actual } };
  }

  return { ok: true, pkg: { name, body, sha256: actual, bytes: Buffer.byteLength(body, 'utf8') } };
}
