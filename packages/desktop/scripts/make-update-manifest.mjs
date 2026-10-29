#!/usr/bin/env node
// node scripts/make-update-manifest.mjs --version 1.2.0 --base-url https://downloads.example.com/aragon/ \
//      --artifacts release/ [--notes-url https://...] [--download-url https://...] [--out latest.json]
//
// Hashes the installers in --artifacts, writes the manifest the app's update check reads, and reads it back
// through the app's own parser before declaring success. Needs `npm run build` first (it imports the
// compiled parser from dist/). The base URL is a PARAMETER of this run, never stored anywhere.
import { writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildManifest, findArtifacts, readBack, sha256File } from './lib/update-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  ?? (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);
const fail = (message) => { console.error(`make-update-manifest: ${message}`); process.exit(2); };

const version = flag('version');
const baseUrl = flag('base-url');
const artifactsDir = flag('artifacts');
if (!version || !baseUrl || !artifactsDir) {
  fail('usage: --version <x.y.z> --base-url <https://...> --artifacts <dir> [--notes-url <https://...>] [--download-url <https://...>] [--out latest.json]');
}

let parseManifest;
try {
  ({ parseManifest } = await import(pathToFileURL(join(root, 'dist', 'main', 'update-service.js')).href));
} catch {
  fail('dist/main/update-service.js is missing - run `npm run build` first (the parser it checks against is compiled from src/main/update-service.ts)');
}

try {
  const dir = resolve(artifactsDir);
  const artifacts = [];
  for (const name of findArtifacts(dir)) {
    const path = join(dir, name);
    artifacts.push({ name, sha256: await sha256File(path), size: statSync(path).size });
  }
  const manifest = buildManifest({
    version, baseUrl, artifacts, notesUrl: flag('notes-url'), downloadUrl: flag('download-url'),
  });
  readBack(manifest, baseUrl, parseManifest);
  const out = resolve(flag('out') ?? 'latest.json');
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${out} (${artifacts.length} artifact(s), version ${version})`);
} catch (error) {
  fail(error.message);
}
