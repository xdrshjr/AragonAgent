/**
 * Loader for unrestricted-mode instruction packages.
 *
 * A package is one Markdown file, byte-stable, validated against a sha256
 * manifest when one is present - the same discipline the gpt-instruct
 * archives use (byte-identical prompt + published digest), so a transcript
 * that names a package name and digest pins exactly one prompt file.
 *
 * THE DIGEST PINS RAW FILE BYTES. The file is read once as a Buffer; the
 * sha256 and the MAX_PACKAGE_BYTES cap both measure that Buffer, and only
 * then is it decoded to text. A digest produced the natural way
 * (`sha256sum file.md`) therefore matches, and two files that differ only in
 * invalid UTF-8 sequences still get different digests (decoding first would
 * collapse both to U+FFFD replacements).
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
 * one without a manifest is ambiguous and refused rather than guessed. With a
 * manifest, the DEFAULT ENTRY's failures are reported truthfully (a declared
 * package whose file is missing is `unreadable`, not "no package"); the
 * package's NAME is the manifest key, because that is the operator's
 * vocabulary - the file name is only a fallback.
 *
 * `file` must be a PLAIN FILE NAME. The directory is the boundary: a manifest
 * entry pointing outside it (`../x.md`, absolute paths) is `bad_manifest`,
 * never a read. The loader is total: every failure is a typed value, never a
 * throw, so the controller can refuse mode entry (and say why) instead of
 * catching.
 *
 * ASCII ONLY - `unrestricted/` is inside the glyph scanner's scope.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { PathLike } from 'node:fs';
import { MAX_PACKAGE_BYTES, MAX_PACKAGES, UNRESTRICTED_DIR_ENV } from './limits.js';

/** One validated instruction package. `sha256` pins the exact file bytes. */
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

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A plain file name, nothing else: no separators, no `.`/`..`, no drive
 * letters. This is the path-traversal guard - the package directory is the
 * boundary, and a manifest that names anything outside it is refused.
 */
function isPlainFileName(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..'
  );
}

function joinUnder(dir: string, file: string): string {
  return `${dir.replace(/[\\/]+$/, '')}/${file}`;
}

/**
 * Load the active package from `dir`.
 *
 * Sync on purpose: it runs once, at controller construction, and every caller
 * (mode toggle, `/plan status` surfaces) needs a yes/no answer immediately.
 */
export function loadUnrestrictedPackage(dir: PathLike): UnrestrictedLoadResult {
  let stats;
  try {
    stats = statSync(dir);
  } catch {
    return { ok: false, failure: { kind: 'no_dir' } };
  }
  if (!stats.isDirectory()) return { ok: false, failure: { kind: 'no_dir' } };

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { ok: false, failure: { kind: 'no_dir' } };
  }

  if (!entries.includes('manifest.json')) {
    const mdFiles = entries.filter((name) => name.toLowerCase().endsWith('.md'));
    if (mdFiles.length === 0) return { ok: false, failure: { kind: 'no_package' } };
    if (mdFiles.length > 1) return { ok: false, failure: { kind: 'ambiguous', count: mdFiles.length } };
    return readPackage(String(dir), mdFiles[0]!, undefined, undefined);
  }

  let manifest: ParsedManifest;
  try {
    manifest = JSON.parse(readFileSync(joinUnder(String(dir), 'manifest.json'), 'utf8')) as ParsedManifest;
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
  if (typeof entry.file !== 'string' || !isPlainFileName(entry.file)) {
    // A missing `file` is a broken manifest; one that escapes the directory
    // (`../x.md`, `C:\x.md`) is refused exactly as firmly - the boundary is
    // the contract, not a suggestion.
    return { ok: false, failure: { kind: 'bad_manifest' } };
  }

  return readPackage(String(dir), entry.file, entry, defaultName);
}

function readPackage(
  dir: string,
  file: string,
  entry: ManifestEntry | undefined,
  manifestName: string | undefined,
): UnrestrictedLoadResult {
  // The manifest key is the operator's name for the package; the file name is
  // only the no-manifest fallback.
  const name = manifestName ?? file.replace(/\.md$/i, '');
  if (!isPlainFileName(file)) return { ok: false, failure: { kind: 'bad_manifest' } };

  let raw: Buffer;
  try {
    raw = readFileSync(joinUnder(dir, file));
  } catch {
    return { ok: false, failure: { kind: 'unreadable', name } };
  }
  if (raw.length > MAX_PACKAGE_BYTES) {
    return { ok: false, failure: { kind: 'too_large', name, bytes: raw.length } };
  }

  const actual = sha256Hex(raw);
  if (typeof entry?.sha256 === 'string' && entry.sha256.length > 0 && entry.sha256 !== actual) {
    return { ok: false, failure: { kind: 'hash_mismatch', name, expected: entry.sha256, actual } };
  }

  // Decode AFTER every byte-level check: invalid sequences become U+FFFD in
  // the body, but the digest above still pins the original file bytes.
  return { ok: true, pkg: { name, body: raw.toString('utf8'), sha256: actual, bytes: raw.length } };
}
