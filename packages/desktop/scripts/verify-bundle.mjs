#!/usr/bin/env node
// Static inspection of what is about to be shipped (AC-36 / AC-38's static half). Exit 0 = clean.
//
//   node scripts/verify-bundle.mjs [--staging <dir>] [--app <unpacked-app-dir>]
//                                  [--flavor release|e2e] [--platform win32|darwin|linux]
//
// With --app it ALSO reads the finished binary: the build flavor baked into app.asar, and the
// Electron fuse wire written into the executable, each compared with the plan in
// `scripts/lib/fuses.mjs`. A release app must be flavor `release` with the hardened fuse set; an
// e2e app must differ from it in exactly the inspector fuse (and the flavor). What is read is the
// artifact, not the build configuration - a configuration that was silently ignored fails here.
//
// It checks the STAGED ENGINE (always) and, when given, an unpacked application directory
// (`release/win-unpacked`). What it can NOT prove is that the installed app loads the engine from
// `resources/engine`: that is `electron . --smoke` run against the unpacked app, which CI runs as
// the second half of AC-38.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE, readDeclaredEngineRanges, satisfies } from './lib/engine-versions.mjs';
import { readBakedFlavor } from './lib/flavor.mjs';
import { expectedWire } from './lib/fuses.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const staging = arg('--staging') ?? join(root, 'build-staging');
const appDir = arg('--app');
const expectFlavor = arg('--flavor') ?? 'release';
const platform = arg('--platform') ?? process.platform;
const problems = [];
const fail = (message) => problems.push(message);

function walk(dir, visit) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else visit(path);
  }
}

const engine = join(staging, 'engine');
if (!existsSync(join(engine, 'node_modules'))) fail(`no staged engine at ${engine} (run \`npm run stage\`)`);

// 1. Versions: what is installed is exactly what the manifest recorded, and inside the range this
//    package declares. The engine is a published npm dependency (it is not in this repository), so
//    the declared range in packages/desktop/package.json is the only source of truth available here.
const manifestPath = join(staging, 'manifest.json');
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const declared = readDeclaredEngineRanges(root);
  for (const name of ENGINE) {
    const installedPath = join(engine, 'node_modules', '@aragon-agent', name, 'package.json');
    if (!existsSync(installedPath)) { fail(`@aragon-agent/${name} is missing from the staged engine`); continue; }
    const version = JSON.parse(readFileSync(installedPath, 'utf8')).version;
    const ok = satisfies(version, declared[name]);
    if (version !== manifest.engine[name] || ok !== true) {
      fail(`@aragon-agent/${name}: installed ${version}, staged ${manifest.engine[name]}, declared ${declared[name]}`);
    }
  }
} else fail('build-staging/manifest.json is missing');

// 2. No native addons and no isolated-vm anywhere (RV-P1-7): a Node-ABI `.node` in an Electron app.
walk(engine, (path) => { if (path.endsWith('.node')) fail(`native addon in the engine: ${relative(staging, path)}`); });
if (existsSync(join(engine, 'node_modules', 'isolated-vm'))) fail('isolated-vm was installed into the engine (stage must use --omit=optional)');

// 3. The host files exist and the entry is plain ESM beside node_modules.
for (const file of ['host/entry.js', 'host/session-worker.js', 'shared/port-protocol.js']) {
  if (!existsSync(join(engine, file))) fail(`staged engine is missing ${file}`);
}

// 4. Declared dependencies: every bare import in the staged host resolves inside engine/node_modules.
const bare = /\bfrom\s*['"]([^'".][^'"]*)['"]|\bimport\s*\(\s*['"]([^'".][^'"]*)['"]\s*\)/g;
walk(join(engine, 'host'), (path) => {
  if (!path.endsWith('.js')) return;
  for (const match of readFileSync(path, 'utf8').matchAll(bare)) {
    const spec = match[1] ?? match[2];
    if (spec.startsWith('node:')) continue;
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (!existsSync(join(engine, 'node_modules', name))) fail(`${relative(staging, path)} imports "${spec}" which is not installed`);
  }
});

// 5. The renderer bundle: no Node built-ins other than the shimmed ones, no source maps shipped.
const rendererDir = join(root, 'dist', 'renderer');
walk(rendererDir, (path) => {
  if (path.endsWith('.map')) fail(`source map in the renderer bundle: ${relative(root, path)}`);
  if (/\.(js|mjs)$/.test(path)) {
    const text = readFileSync(path, 'utf8');
    for (const builtin of ['node:fs', 'node:child_process', 'node:net', 'node:os', 'require("fs")', "require('fs')"]) {
      if (text.includes(builtin)) fail(`renderer bundle references ${builtin}: ${relative(root, path)}`);
    }
  }
});

// 6. The preload is ONE CommonJS file.
const preload = join(root, 'dist', 'preload', 'index.cjs');
if (!existsSync(preload)) fail('dist/preload/index.cjs is missing');
else if (/^\s*(import|export)\s/m.test(readFileSync(preload, 'utf8'))) fail('the preload contains ESM syntax; it must be a single CommonJS file');

// 7. An unpacked application: no maps or tests in the asar tree, engine present in resources.
if (appDir) {
  const resources = join(appDir, 'resources');
  if (!existsSync(join(resources, 'engine', 'node_modules', '@aragon-agent', 'cli', 'dist', 'host', 'settings.js'))) {
    fail('the installed app has no engine at resources/engine (engine-loader would fail on first launch)');
  }
  walk(join(resources, 'engine'), (path) => { if (path.endsWith('.node')) fail(`native addon in the installed app: ${relative(appDir, path)}`); });
  if (existsSync(join(resources, 'engine', 'node_modules', 'isolated-vm'))) fail('isolated-vm is present in the installed app');
  if (!existsSync(join(resources, 'app.asar'))) fail('resources/app.asar is missing');
  await verifyArtifact(appDir, join(resources, 'app.asar'));
}

/** The flavor inside app.asar and the fuse wire of the executable, against the plan. */
async function verifyArtifact(app, asar) {
  // 8a. Flavor. Read from the asar, i.e. from what the user's machine will actually run.
  try {
    const { extractFile } = await import('@electron/asar');
    const baked = readBakedFlavor(extractFile(asar, join('dist', 'main', 'build-flavor.js')).toString('utf8'));
    if (baked === undefined) fail('dist/main/build-flavor.js in app.asar has no recognisable BAKED_FLAVOR line');
    else if (baked !== expectFlavor) fail(`app.asar is flavor ${JSON.stringify(baked)}, expected ${JSON.stringify(expectFlavor)}`);
  } catch (error) {
    fail(`cannot read build-flavor.js from app.asar: ${error instanceof Error ? error.message : error}`);
  }
  // 8b. Fuses. Read from the executable.
  try {
    const { getCurrentFuseWire, FuseV1Options } = await import('@electron/fuses');
    const ENABLE = 49; // FuseState.ENABLE; the package does not export the enum from its entry point
    const exe = findExecutable(app);
    if (!exe) { fail(`no Electron executable found in ${app}`); return; }
    const wire = await getCurrentFuseWire(exe);
    for (const [name, wanted] of Object.entries(expectedWire(expectFlavor, platform))) {
      const state = wire[FuseV1Options[name]];
      const actual = state === ENABLE;
      if (actual !== wanted) fail(`fuse ${name} is ${actual ? 'on' : 'off'}, expected ${wanted ? 'on' : 'off'} for a ${expectFlavor} build`);
    }
  } catch (error) {
    fail(`cannot read the fuse wire: ${error instanceof Error ? error.message : error}`);
  }
}

function findExecutable(app) {
  if (!existsSync(app)) return null;
  if (platform === 'darwin') {
    for (const entry of readdirSync(app)) if (entry.endsWith('.app')) return join(app, entry);
    return null;
  }
  const name = platform === 'win32' ? /\.exe$/i : /^[^.]+$/;
  const skip = new Set(['chrome_crashpad_handler', 'chrome-sandbox', 'resources', 'locales']);
  for (const entry of readdirSync(app, { withFileTypes: true })) {
    if (entry.isFile() && name.test(entry.name) && !skip.has(entry.name) && !/^(Uninstall|elevate)/i.test(entry.name)) {
      return join(app, entry.name);
    }
  }
  return null;
}

if (problems.length > 0) {
  console.error(problems.map((line) => `verify-bundle: ${line}`).join('\n'));
  console.error(`\nverify-bundle: ${problems.length} problem(s)`);
  process.exit(1);
}
const size = (() => { let total = 0; walk(engine, (p) => { total += statSync(p).size; }); return (total / 1048576).toFixed(1); })();
console.log(`verify-bundle: OK (engine ${size} MB, no native addons, no isolated-vm, all host imports resolvable)`);
