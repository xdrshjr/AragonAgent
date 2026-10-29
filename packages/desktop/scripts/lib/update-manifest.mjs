// Build the update-notification manifest (`latest.json`) for a set of release artifacts.
//
// The SHAPE is not described here: it is whatever `parseManifest` in src/main/update-service.ts accepts,
// and `buildManifest` proves it by reading its own output back through that parser (`readBack`). The
// parser drops fields it does not know (today: everything but version / downloadUrl / notesUrl /
// releasedAt), so the per-artifact `sha256` and `size` written here are for humans and for a future
// in-app installer; they cannot be mistaken for something the app already verifies.
//
// `--base-url` goes into the manifest's links ONLY. It is never written into source or
// electron-builder.yml: where updates are served from is a product decision (README, "Release runbook").
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const INSTALLER_EXTENSIONS = new Map([
  ['.exe', 'win'], ['.msi', 'win'], ['.dmg', 'mac'], ['.pkg', 'mac'], ['.appimage', 'linux'], ['.deb', 'linux'], ['.rpm', 'linux'],
]);

export function platformOf(fileName) {
  return INSTALLER_EXTENSIONS.get(extname(fileName).toLowerCase()) ?? null;
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/** Installers directly inside `dir` (not recursive: a packaged app folder is not an artifact). */
export function findArtifacts(dir) {
  let names;
  try { names = readdirSync(dir); } catch { throw new Error(`artifacts directory not found: ${dir}`); }
  const found = names.filter((name) => platformOf(name) !== null && statSync(join(dir, name)).isFile()).sort();
  if (found.length === 0) throw new Error(`no installer artifacts (.exe .msi .dmg .pkg .AppImage .deb .rpm) in ${dir}`);
  return found;
}

export function assertHttpsBase(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error(`--base-url is not a URL: ${baseUrl}`); }
  if (url.protocol !== 'https:') throw new Error(`--base-url must be https (got ${url.protocol}//): an update link over plain http can be rewritten in transit`);
  if (url.username || url.password) throw new Error('--base-url must not contain credentials');
  return url;
}

const joinUrl = (base, name) => `${base.href.replace(/\/+$/, '')}/${encodeURIComponent(name)}`;

/**
 * `artifacts`: `[{ name, sha256, size }]`. `downloadUrl` defaults to the artifact's own address when there is
 * exactly one, and otherwise to the base address (a downloads page) - the current parser carries a single link.
 */
export function buildManifest({ version, baseUrl, artifacts, notesUrl, releasedAt, downloadUrl }) {
  const base = assertHttpsBase(baseUrl);
  const entries = artifacts.map((artifact) => ({
    file: artifact.name, platform: platformOf(artifact.name), url: joinUrl(base, artifact.name), sha256: artifact.sha256, size: artifact.size,
  }));
  return {
    version,
    releasedAt: releasedAt ?? new Date().toISOString(),
    ...(notesUrl ? { notesUrl } : {}),
    downloadUrl: downloadUrl ?? (entries.length === 1 ? entries[0].url : base.href),
    artifacts: entries,
  };
}

/**
 * Read the manifest back through the app's own parser. `parse` is `parseManifest`; the allowed host is the
 * base URL's host, which is what the product owner would put in the build's host list.
 */
export function readBack(manifest, baseUrl, parse) {
  const host = new URL(baseUrl).hostname;
  const parsed = parse(JSON.stringify(manifest), { allowedHosts: [host], allowLoopbackHttp: false });
  if (parsed === null) throw new Error('the generated manifest is rejected by the app\'s own parser (update-service.ts parseManifest)');
  if (parsed.version !== manifest.version) throw new Error(`the parser read version ${parsed.version}, expected ${manifest.version}`);
  return parsed;
}
